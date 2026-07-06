import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TEMPLATE_FILE = path.join(ROOT, 'template.json');

export const HOUSING_STATES = ['未確認', '利用する', '利用しない'];

// ---- 永続化 ----

function emptyDb() {
  return { employees: [] };
}

export function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return emptyDb();
  }
}

export function saveDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export function loadTemplate() {
  return JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
}

// ---- 日付ユーティリティ ----

export function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

// ---- 従業員・タスク生成 ----

export function buildTasks(template, joinDate) {
  return template.tasks.map((t) => ({
    id: crypto.randomUUID(),
    templateId: t.id,
    phaseId: t.phaseId,
    title: t.title,
    description: t.description || '',
    assignee: t.assignee || '人事',
    condition: t.condition || null,
    dueDate: addDays(joinDate, t.offsetDays),
    status: 'todo', // todo | done
    completedAt: null,
  }));
}

export function createEmployee(db, template, input) {
  const errors = [];
  if (!input.name || !String(input.name).trim()) errors.push('氏名は必須です');
  if (!isValidDate(input.joinDate)) errors.push('入社日は YYYY-MM-DD 形式で指定してください');
  if (input.housingUse && !HOUSING_STATES.includes(input.housingUse)) {
    errors.push(`社宅利用は ${HOUSING_STATES.join(' / ')} のいずれかです`);
  }
  if (errors.length) return { errors };

  const employee = {
    id: crypto.randomUUID(),
    name: String(input.name).trim(),
    email: String(input.email || '').trim(),
    position: String(input.position || '').trim(),
    department: String(input.department || '').trim(),
    joinDate: input.joinDate,
    housingUse: input.housingUse || '未確認',
    source: input.source || 'manual',
    notes: String(input.notes || ''),
    archived: false,
    createdAt: new Date().toISOString(),
    tasks: buildTasks(template, input.joinDate),
  };
  db.employees.push(employee);
  return { employee };
}

export function updateEmployee(db, template, id, patch) {
  const emp = db.employees.find((e) => e.id === id);
  if (!emp) return { errors: ['対象の従業員が見つかりません'] };

  if (patch.housingUse !== undefined && !HOUSING_STATES.includes(patch.housingUse)) {
    return { errors: [`社宅利用は ${HOUSING_STATES.join(' / ')} のいずれかです`] };
  }
  if (patch.joinDate !== undefined && !isValidDate(patch.joinDate)) {
    return { errors: ['入社日は YYYY-MM-DD 形式で指定してください'] };
  }

  for (const key of ['name', 'email', 'position', 'department', 'housingUse', 'notes']) {
    if (patch[key] !== undefined) emp[key] = String(patch[key]);
  }
  if (patch.archived !== undefined) emp.archived = Boolean(patch.archived);

  // 入社日変更時は未完了タスクの期日を再計算する
  if (patch.joinDate !== undefined && patch.joinDate !== emp.joinDate) {
    emp.joinDate = patch.joinDate;
    const offsets = new Map(template.tasks.map((t) => [t.id, t.offsetDays]));
    for (const task of emp.tasks) {
      if (task.status === 'done') continue;
      const offset = offsets.get(task.templateId);
      if (offset !== undefined) task.dueDate = addDays(emp.joinDate, offset);
    }
  }
  return { employee: emp };
}

export function updateTask(db, employeeId, taskId, patch) {
  const emp = db.employees.find((e) => e.id === employeeId);
  if (!emp) return { errors: ['対象の従業員が見つかりません'] };
  const task = emp.tasks.find((t) => t.id === taskId);
  if (!task) return { errors: ['対象のタスクが見つかりません'] };

  if (patch.status !== undefined) {
    if (!['todo', 'done'].includes(patch.status)) return { errors: ['status は todo / done のいずれかです'] };
    task.status = patch.status;
    task.completedAt = patch.status === 'done' ? new Date().toISOString() : null;
  }
  if (patch.assignee !== undefined) task.assignee = String(patch.assignee);
  if (patch.dueDate !== undefined) {
    if (!isValidDate(patch.dueDate)) return { errors: ['期日は YYYY-MM-DD 形式で指定してください'] };
    task.dueDate = patch.dueDate;
  }
  return { employee: emp, task };
}

// 社宅条件を考慮した「対象タスク」判定
// - 社宅を「利用しない」場合、condition: "housing" のタスクは対象外
export function isTaskApplicable(task, employee) {
  if (task.condition === 'housing') return employee.housingUse !== '利用しない';
  return true;
}

export function progressOf(employee) {
  const applicable = employee.tasks.filter((t) => isTaskApplicable(t, employee));
  const done = applicable.filter((t) => t.status === 'done');
  return { total: applicable.length, done: done.length };
}

function normalizeDate(s) {
  const m = String(s).trim().match(/^(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})日?$/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function findDuplicate(db, { name, email, joinDate }) {
  return db.employees.find(
    (e) => !e.archived && (email ? e.email === email : e.name === name && e.joinDate === joinDate)
  );
}

// ---- HERP Webhook 連携 ----
// HERPの「採用決定」通知Webhookを受けて自動登録する。
// ペイロードのキー名はHERP側の設定・バージョンで揺れうるため、
// 代表的なキー名を総当たりで探索する（candidate 等のネストにも対応）。

const WEBHOOK_KEY_ALIASES = {
  name: ['name', 'candidatename', 'candidate_name', 'fullname', 'full_name', '氏名', '名前', '候補者名'],
  email: ['email', 'mailaddress', 'mail_address', 'mail', 'メールアドレス', 'メール'],
  position: ['position', 'jobposition', 'job_position', 'jobtitle', 'requisition', 'ポジション', '応募ポジション', '求人', '職種'],
  department: ['department', 'division', '部署', '配属部署', '部門'],
  joinDate: ['joindate', 'join_date', 'hiredate', 'hire_date', 'enterdate', 'enter_date', 'entrydate', 'entry_date', '入社日', '入社予定日'],
};

function pickField(obj, aliases) {
  for (const [key, value] of Object.entries(obj)) {
    if (aliases.includes(key.toLowerCase().replace(/[\s_-]/g, '')) || aliases.includes(key.toLowerCase())) {
      if (value !== null && value !== undefined && String(value).trim() !== '') return String(value).trim();
    }
  }
  return '';
}

export function registerFromWebhook(db, template, payload) {
  if (!payload || typeof payload !== 'object') return { errors: ['ペイロードがJSONオブジェクトではありません'] };
  // candidate / applicant / data のネストがあれば中身を優先して探索する
  const scopes = [payload.candidate, payload.applicant, payload.data, payload].filter(
    (s) => s && typeof s === 'object'
  );

  const pick = (key) => {
    for (const scope of scopes) {
      const v = pickField(scope, WEBHOOK_KEY_ALIASES[key]);
      if (v) return v;
    }
    return '';
  };

  const name = pick('name');
  const rawJoinDate = pick('joinDate');
  const joinDate = normalizeDate(rawJoinDate) || (isValidDate(rawJoinDate) ? rawJoinDate : null);
  if (!name) return { errors: ['ペイロードから氏名を特定できませんでした'] };
  if (!joinDate) return { errors: [`ペイロードから入社日を特定できませんでした（受信値: "${rawJoinDate}"）`] };

  const email = pick('email');
  const duplicate = findDuplicate(db, { name, email, joinDate });
  if (duplicate) return { duplicate };

  return createEmployee(db, template, {
    name, email, joinDate,
    position: pick('position'),
    department: pick('department'),
    source: 'herp-webhook',
  });
}
