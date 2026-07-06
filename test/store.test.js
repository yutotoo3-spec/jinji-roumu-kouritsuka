import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTemplate, createEmployee, updateEmployee, updateTask,
  importHerpCsv, isTaskApplicable, progressOf, addDays, parseCsv,
} from '../lib/store.js';

const template = loadTemplate();
const emptyDb = () => ({ employees: [] });

test('テンプレート: 全タスクのphaseIdが定義済みフェーズを参照している', () => {
  const phaseIds = new Set(template.phases.map((p) => p.id));
  for (const t of template.tasks) {
    assert.ok(phaseIds.has(t.phaseId), `${t.id} のphaseId "${t.phaseId}" が未定義`);
  }
});

test('addDays: 月またぎ・負のオフセットを正しく計算する', () => {
  assert.equal(addDays('2026-08-01', -14), '2026-07-18');
  assert.equal(addDays('2026-08-01', 10), '2026-08-11');
  assert.equal(addDays('2026-01-03', -5), '2025-12-29');
});

test('createEmployee: テンプレート全タスクが期日付きで生成される', () => {
  const db = emptyDb();
  const { employee, errors } = createEmployee(db, template, {
    name: '山田 太郎', joinDate: '2026-08-01',
  });
  assert.equal(errors, undefined);
  assert.equal(employee.tasks.length, template.tasks.length);
  assert.equal(employee.housingUse, '未確認');

  const shakaiHoken = employee.tasks.find((t) => t.templateId === 'labor-shakai-hoken');
  assert.equal(shakaiHoken.dueDate, '2026-08-06'); // 入社日+5日
  const offer = employee.tasks.find((t) => t.templateId === 'contract-offer-letter');
  assert.equal(offer.dueDate, '2026-07-02'); // 入社日-30日
});

test('createEmployee: バリデーションエラーを返す', () => {
  const db = emptyDb();
  assert.ok(createEmployee(db, template, { name: '', joinDate: '2026-08-01' }).errors);
  assert.ok(createEmployee(db, template, { name: 'A', joinDate: '8月1日' }).errors);
  assert.ok(createEmployee(db, template, { name: 'A', joinDate: '2026-08-01', housingUse: 'たぶん' }).errors);
  assert.equal(db.employees.length, 0);
});

test('社宅条件: 利用しない場合は housing タスクが対象外になり進捗から除外される', () => {
  const db = emptyDb();
  const { employee } = createEmployee(db, template, {
    name: '山田 太郎', joinDate: '2026-08-01', housingUse: '利用しない',
  });
  const housingTasks = employee.tasks.filter((t) => t.condition === 'housing');
  assert.ok(housingTasks.length > 0);
  for (const t of housingTasks) assert.equal(isTaskApplicable(t, employee), false);

  const { total } = progressOf(employee);
  assert.equal(total, template.tasks.length - housingTasks.length);

  // 利用するに変更すると対象に戻る
  updateEmployee(db, template, employee.id, { housingUse: '利用する' });
  assert.equal(progressOf(employee).total, template.tasks.length);
});

test('updateEmployee: 入社日変更で未完了タスクのみ期日が再計算される', () => {
  const db = emptyDb();
  const { employee } = createEmployee(db, template, { name: 'A', joinDate: '2026-08-01' });
  const offer = employee.tasks.find((t) => t.templateId === 'contract-offer-letter');
  const shakaiHoken = employee.tasks.find((t) => t.templateId === 'labor-shakai-hoken');
  updateTask(db, employee.id, offer.id, { status: 'done' });
  const offerDueBefore = offer.dueDate;

  updateEmployee(db, template, employee.id, { joinDate: '2026-09-01' });
  assert.equal(offer.dueDate, offerDueBefore); // 完了済みは変更しない
  assert.equal(shakaiHoken.dueDate, '2026-09-06'); // 未完了は再計算
});

test('updateTask: 完了・未完了の切り替えと completedAt の管理', () => {
  const db = emptyDb();
  const { employee } = createEmployee(db, template, { name: 'A', joinDate: '2026-08-01' });
  const task = employee.tasks[0];

  updateTask(db, employee.id, task.id, { status: 'done' });
  assert.equal(task.status, 'done');
  assert.ok(task.completedAt);

  updateTask(db, employee.id, task.id, { status: 'todo' });
  assert.equal(task.status, 'todo');
  assert.equal(task.completedAt, null);

  assert.ok(updateTask(db, employee.id, task.id, { status: 'invalid' }).errors);
  assert.ok(updateTask(db, 'nope', task.id, { status: 'done' }).errors);
});

test('parseCsv: 引用符・改行入りフィールドを解釈する', () => {
  const rows = parseCsv('a,b,c\n"x,y","line1\nline2",z\r\n1,2,3\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x,y', 'line1\nline2', 'z'], ['1', '2', '3']]);
});

test('importHerpCsv: HERP形式のヘッダーを取り込み、重複・不正行はスキップする', () => {
  const db = emptyDb();
  const csv = [
    '氏名,メールアドレス,応募ポジション,部署,入社予定日',
    '山田 太郎,taro@example.com,エンジニア,開発部,2026/8/1',
    '佐藤 花子,hanako@example.com,セールス,営業部,2026-08-15',
    ',missing@example.com,PM,開発部,2026-08-01',
    '田中 実,minoru@example.com,デザイナー,開発部,来月',
  ].join('\n');

  const result = importHerpCsv(db, template, csv);
  assert.equal(result.imported.length, 2);
  assert.equal(result.skipped.length, 2);
  assert.equal(db.employees[0].joinDate, '2026-08-01'); // 2026/8/1 を正規化
  assert.equal(db.employees[0].source, 'herp-csv');

  // 同じメールアドレスは重複としてスキップ
  const again = importHerpCsv(db, template, csv);
  assert.equal(again.imported.length, 0);
  assert.equal(db.employees.length, 2);
});

test('importHerpCsv: 必須列がないCSVはエラー', () => {
  const db = emptyDb();
  const result = importHerpCsv(db, template, '名字,メール\n山田,a@example.com');
  assert.ok(result.errors);
});
