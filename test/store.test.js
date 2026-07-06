import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTemplate, createEmployee, updateEmployee, updateTask,
  registerFromWebhook, isTaskApplicable, progressOf, addDays,
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

test('registerFromWebhook: 英語キーのフラットなペイロードを登録できる', () => {
  const db = emptyDb();
  const { employee, errors } = registerFromWebhook(db, template, {
    name: '山田 太郎',
    email: 'taro@example.com',
    position: 'エンジニア',
    join_date: '2026/9/1',
  });
  assert.equal(errors, undefined);
  assert.equal(employee.joinDate, '2026-09-01');
  assert.equal(employee.source, 'herp-webhook');
  assert.equal(employee.tasks.length, template.tasks.length);
});

test('registerFromWebhook: candidateネスト・日本語キーのペイロードも解釈する', () => {
  const db = emptyDb();
  const { employee, errors } = registerFromWebhook(db, template, {
    event: 'candidate.hired',
    candidate: { '氏名': '佐藤 花子', 'メールアドレス': 'hanako@example.com', '入社予定日': '2026年10月1日', '応募ポジション': 'セールス' },
  });
  assert.equal(errors, undefined);
  assert.equal(employee.name, '佐藤 花子');
  assert.equal(employee.joinDate, '2026-10-01');
  assert.equal(employee.position, 'セールス');
});

test('registerFromWebhook: 重複は登録せず duplicate を返す', () => {
  const db = emptyDb();
  const payload = { name: '山田 太郎', email: 'taro@example.com', joinDate: '2026-09-01' };
  registerFromWebhook(db, template, payload);
  const second = registerFromWebhook(db, template, payload);
  assert.ok(second.duplicate);
  assert.equal(db.employees.length, 1);
});

test('registerFromWebhook: 氏名・入社日を特定できない場合はエラー', () => {
  const db = emptyDb();
  assert.ok(registerFromWebhook(db, template, { email: 'a@example.com' }).errors);
  assert.ok(registerFromWebhook(db, template, { name: '山田', joinDate: '来月' }).errors);
  assert.ok(registerFromWebhook(db, template, null).errors);
});
