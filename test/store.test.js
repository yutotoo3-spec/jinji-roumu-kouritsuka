import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTemplates, getTemplate, createEmployee, updateEmployee, updateTask,
  registerFromWebhook, isTaskApplicable, progressOf, addDays,
  findByPortalToken, portalView, submitBasicInfo, setPortalTaskStatus, buildDigest, todayStr,
} from '../lib/store.js';

const templates = loadTemplates();
const fulltime = getTemplate(templates, 'fulltime');
const contractor = getTemplate(templates, 'contractor');
const emptyDb = () => ({ employees: [] });

test('テンプレート: 全雇用区分で phaseId が定義済みフェーズを参照している', () => {
  for (const tpl of templates.employmentTypes) {
    const phaseIds = new Set(tpl.phases.map((p) => p.id));
    for (const t of tpl.tasks) {
      assert.ok(phaseIds.has(t.phaseId), `${tpl.id}/${t.id} のphaseId "${t.phaseId}" が未定義`);
    }
  }
});

test('addDays: 月またぎ・負のオフセットを正しく計算する', () => {
  assert.equal(addDays('2026-08-01', -14), '2026-07-18');
  assert.equal(addDays('2026-08-01', 10), '2026-08-11');
  assert.equal(addDays('2026-01-03', -5), '2025-12-29');
});

test('createEmployee(正社員): 全タスクが期日付きで生成され、ポータルトークンを持つ', () => {
  const db = emptyDb();
  const { employee, errors } = createEmployee(db, templates, {
    name: '山田 太郎', joinDate: '2026-08-01', herpUrl: 'https://agent.herp.cloud/p/candidates/abc123',
  });
  assert.equal(errors, undefined);
  assert.equal(employee.employmentType, 'fulltime');
  assert.equal(employee.tasks.length, fulltime.tasks.length);
  assert.equal(employee.housingUse, '未確認');
  assert.equal(employee.herpUrl, 'https://agent.herp.cloud/p/candidates/abc123');
  assert.match(employee.portalToken, /^[0-9a-f]{32}$/);

  const shakaiHoken = employee.tasks.find((t) => t.templateId === 'labor-shakai-hoken');
  assert.equal(shakaiHoken.dueDate, '2026-08-06'); // 入社日+5日
  const followup = employee.tasks.find((t) => t.templateId === 'followup-30');
  assert.equal(followup.dueDate, '2026-08-31'); // 入社日+30日
});

test('createEmployee(業務委託): 社保・社宅タスクを含まず、契約管理タスクを含む', () => {
  const db = emptyDb();
  const { employee, errors } = createEmployee(db, templates, {
    name: '外部 次郎', joinDate: '2026-08-01', employmentType: 'contractor',
  });
  assert.equal(errors, undefined);
  assert.equal(employee.employmentType, 'contractor');
  assert.equal(employee.housingUse, null); // 業務委託に社宅はない
  assert.equal(employee.tasks.length, contractor.tasks.length);
  assert.ok(!employee.tasks.some((t) => t.templateId === 'labor-shakai-hoken'), '社会保険タスクが混入');
  assert.ok(!employee.tasks.some((t) => t.condition === 'housing'), '社宅タスクが混入');
  assert.ok(employee.tasks.some((t) => t.templateId === 'c-renewal'), '契約更新タスクがない');
});

test('createEmployee: バリデーションエラーを返す', () => {
  const db = emptyDb();
  assert.ok(createEmployee(db, templates, { name: '', joinDate: '2026-08-01' }).errors);
  assert.ok(createEmployee(db, templates, { name: 'A', joinDate: '8月1日' }).errors);
  assert.ok(createEmployee(db, templates, { name: 'A', joinDate: '2026-08-01', housingUse: 'たぶん' }).errors);
  assert.ok(createEmployee(db, templates, { name: 'A', joinDate: '2026-08-01', employmentType: 'parttime' }).errors);
  assert.equal(db.employees.length, 0);
});

test('社宅条件: 利用しない場合は housing タスクが対象外になり進捗から除外される', () => {
  const db = emptyDb();
  const { employee } = createEmployee(db, templates, {
    name: '山田 太郎', joinDate: '2026-08-01', housingUse: '利用しない',
  });
  const housingTasks = employee.tasks.filter((t) => t.condition === 'housing');
  assert.ok(housingTasks.length > 0);
  for (const t of housingTasks) assert.equal(isTaskApplicable(t, employee), false);

  const { total } = progressOf(employee);
  assert.equal(total, fulltime.tasks.length - housingTasks.length);

  updateEmployee(db, templates, employee.id, { housingUse: '利用する' });
  assert.equal(progressOf(employee).total, fulltime.tasks.length);
});

test('updateEmployee: 業務委託への社宅設定は拒否される', () => {
  const db = emptyDb();
  const { employee } = createEmployee(db, templates, {
    name: '外部 次郎', joinDate: '2026-08-01', employmentType: 'contractor',
  });
  const result = updateEmployee(db, templates, employee.id, { housingUse: '利用する' });
  assert.ok(result.errors);
});

test('updateEmployee: 入社日変更で未完了タスクのみ期日が再計算される（雇用区分別テンプレートを参照）', () => {
  const db = emptyDb();
  const { employee } = createEmployee(db, templates, { name: 'A', joinDate: '2026-08-01', employmentType: 'contractor' });
  const scope = employee.tasks.find((t) => t.templateId === 'c-scope');
  const renewal = employee.tasks.find((t) => t.templateId === 'c-renewal');
  updateTask(db, employee.id, scope.id, { status: 'done' });
  const scopeDueBefore = scope.dueDate;

  updateEmployee(db, templates, employee.id, { joinDate: '2026-09-01' });
  assert.equal(scope.dueDate, scopeDueBefore); // 完了済みは変更しない
  assert.equal(renewal.dueDate, addDays('2026-09-01', 60)); // 未完了は再計算
});

test('updateTask: 完了・未完了の切り替えと completedAt の管理', () => {
  const db = emptyDb();
  const { employee } = createEmployee(db, templates, { name: 'A', joinDate: '2026-08-01' });
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
  const { employee, errors } = registerFromWebhook(db, templates, {
    name: '山田 太郎',
    email: 'taro@example.com',
    position: 'エンジニア',
    join_date: '2026/9/1',
    candidate_url: 'https://agent.herp.cloud/p/candidates/xyz789',
  });
  assert.equal(errors, undefined);
  assert.equal(employee.joinDate, '2026-09-01');
  assert.equal(employee.source, 'herp-webhook');
  assert.equal(employee.employmentType, 'fulltime');
  assert.equal(employee.herpUrl, 'https://agent.herp.cloud/p/candidates/xyz789');
});

test('registerFromWebhook: 雇用区分「業務委託」を判定し、candidateネスト・日本語キーも解釈する', () => {
  const db = emptyDb();
  const { employee, errors } = registerFromWebhook(db, templates, {
    event: 'candidate.hired',
    candidate: { '氏名': '佐藤 花子', 'メールアドレス': 'hanako@example.com', '入社予定日': '2026年10月1日', '雇用形態': '業務委託' },
  });
  assert.equal(errors, undefined);
  assert.equal(employee.employmentType, 'contractor');
  assert.equal(employee.joinDate, '2026-10-01');
  assert.ok(!employee.tasks.some((t) => t.templateId === 'labor-shakai-hoken'));
});

test('registerFromWebhook: 重複は登録せず duplicate を返す', () => {
  const db = emptyDb();
  const payload = { name: '山田 太郎', email: 'taro@example.com', joinDate: '2026-09-01' };
  registerFromWebhook(db, templates, payload);
  const second = registerFromWebhook(db, templates, payload);
  assert.ok(second.duplicate);
  assert.equal(db.employees.length, 1);
});

test('registerFromWebhook: 氏名・入社日を特定できない場合はエラー', () => {
  const db = emptyDb();
  assert.ok(registerFromWebhook(db, templates, { email: 'a@example.com' }).errors);
  assert.ok(registerFromWebhook(db, templates, { name: '山田', joinDate: '来月' }).errors);
  assert.ok(registerFromWebhook(db, templates, null).errors);
});

test('ポータル: 本人タスクのみ公開され、人事用の情報は含まれない', () => {
  const db = emptyDb();
  const { employee } = createEmployee(db, templates, {
    name: '山田 太郎', joinDate: '2026-08-01', notes: '年収600万円', herpUrl: 'https://agent.herp.cloud/x',
  });
  const emp = findByPortalToken(db, employee.portalToken);
  assert.equal(emp.id, employee.id);
  assert.equal(findByPortalToken(db, 'ffffffffffffffffffffffffffffffff'), null);

  const view = portalView(templates, emp);
  assert.ok(view.tasks.length > 0);
  assert.ok(view.tasks.every((t) => emp.tasks.find((x) => x.id === t.id).assignee === '本人'));
  const json = JSON.stringify(view);
  assert.ok(!json.includes('年収600万円'), '人事メモが漏れている');
  assert.ok(!json.includes('herp.cloud'), 'HERP URLが漏れている');
  assert.ok(!json.includes(employee.id), '内部IDが漏れている');
});

test('ポータル: 基礎情報の提出で対応タスクが自動完了する（正社員: info-basic / 業務委託: c-bank）', () => {
  const db = emptyDb();
  const { employee: ft } = createEmployee(db, templates, { name: 'A', joinDate: '2026-08-01' });
  submitBasicInfo(db, ft.portalToken, { address: '東京都千代田区1-1', phone: '090-0000-0000', bankAccount: 'X銀行 普通 1234567' });
  assert.equal(ft.basicInfo.address, '東京都千代田区1-1');
  assert.equal(ft.tasks.find((t) => t.templateId === 'info-basic').status, 'done');

  const { employee: ct } = createEmployee(db, templates, { name: 'B', joinDate: '2026-08-01', employmentType: 'contractor' });
  submitBasicInfo(db, ct.portalToken, { bankAccount: 'Y銀行 普通 7654321' });
  assert.equal(ct.tasks.find((t) => t.templateId === 'c-bank').status, 'done');

  assert.ok(submitBasicInfo(db, ft.portalToken, {}).errors); // 空提出はエラー
  assert.ok(submitBasicInfo(db, 'ffffffffffffffffffffffffffffffff', { address: 'x' }).errors);
});

test('ポータル: 本人担当タスクだけ完了報告でき、人事担当タスクは操作できない', () => {
  const db = emptyDb();
  const { employee } = createEmployee(db, templates, { name: 'A', joinDate: '2026-08-01' });
  const selfTask = employee.tasks.find((t) => t.assignee === '本人');
  const hrTask = employee.tasks.find((t) => t.assignee === '人事');

  const ok = setPortalTaskStatus(db, employee.portalToken, selfTask.id, 'done');
  assert.equal(ok.task.status, 'done');
  assert.ok(setPortalTaskStatus(db, employee.portalToken, hrTask.id, 'done').errors);
  assert.equal(hrTask.status, 'todo');
});

test('Slackダイジェスト: 超過・本日期日・社宅未確認を含み、業務委託は社宅集計から除外', () => {
  const db = emptyDb();
  const { employee: ft } = createEmployee(db, templates, { name: '正社員 太郎', joinDate: addDays(todayStr(), 3) });
  createEmployee(db, templates, { name: '委託 花子', joinDate: addDays(todayStr(), 3), employmentType: 'contractor' });

  // 期限超過と本日期日を作る
  ft.tasks[0].dueDate = addDays(todayStr(), -2);
  ft.tasks[1].dueDate = todayStr();

  const digest = buildDigest(db);
  assert.equal(digest.hasItems, true);
  assert.ok(digest.text.includes('期限超過'));
  assert.ok(digest.text.includes('本日期日'));
  assert.ok(digest.text.includes('正社員 太郎'));
  const housingLine = digest.text.split('\n').find((l) => l.includes('社宅利用が未確認'));
  assert.ok(housingLine);
  assert.ok(housingLine.includes('正社員 太郎'));
  assert.ok(!housingLine.includes('委託 花子'), '業務委託が社宅未確認に含まれている');
});

test('Slackダイジェスト: 本人担当の期日間近タスクがあると「本人対応待ち」に載る', () => {
  const db = emptyDb();
  const { employee } = createEmployee(db, templates, { name: '提出 待子', joinDate: addDays(todayStr(), 60) });
  const selfTask = employee.tasks.find((t) => t.assignee === '本人');
  selfTask.dueDate = addDays(todayStr(), 2); // 期日2日後・未対応

  const digest = buildDigest(db);
  const remindLine = digest.text.split('\n').find((l) => l.includes('本人対応待ち'));
  assert.ok(remindLine, '本人対応待ちセクションがない');
  assert.ok(remindLine.includes('提出 待子（1件）'));

  // 完了すると消える
  selfTask.status = 'done';
  const digest2 = buildDigest(db);
  assert.ok(!digest2.text.includes('本人対応待ち'));
});

test('Slackダイジェスト: 対象がなければ hasItems=false', () => {
  const digest = buildDigest(emptyDb());
  assert.equal(digest.hasItems, false);
});

test('設定: 既定はSlack通知オン、更新が反映される', async () => {
  const { getSettings, updateSettings } = await import('../lib/store.js');
  const db = emptyDb();
  assert.equal(getSettings(db).slackEnabled, true);
  // 古いデータ（settingsなし）でも既定値が返る
  assert.equal(getSettings({ employees: [] }).slackEnabled, true);

  const updated = updateSettings(db, { slackEnabled: false });
  assert.equal(updated.slackEnabled, false);
  assert.equal(getSettings(db).slackEnabled, false);
  updateSettings(db, { slackEnabled: true });
  assert.equal(getSettings(db).slackEnabled, true);
});
