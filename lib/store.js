import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TEMPLATE_FILE = path.join(ROOT, 'template.json');

export const HOUSING_STATES = ['未確認', '利用する', '利用しない'];
export const DEFAULT_EMPLOYMENT_TYPE = 'fulltime';

// ---- 永続化 ----
// 既定はローカルファイル（data/db.json）。
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN を設定すると
// Upstash Redis（無料枠あり）に保存する。永続ディスクのない無料ホスティング
// （Render Free等）でもデータが消えない構成にできる。

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UPSTASH_DB_KEY = process.env.UPSTASH_DB_KEY || 'onboarding-db';
export const STORAGE_MODE = UPSTASH_URL && UPSTASH_TOKEN ? 'upstash' : 'file';

function emptyDb() {
  return { employees: [] };
}

export async function loadDb() {
  if (STORAGE_MODE === 'upstash') {
    const res = await fetch(`${UPSTASH_URL}/get/${UPSTASH_DB_KEY}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!res.ok) throw new Error(`データの読み込みに失敗しました（ストレージ応答: ${res.status}）`);
    const { result } = await res.json();
    return result ? JSON.parse(result) : emptyDb();
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return emptyDb();
  }
}

export async function saveDb(db) {
  if (STORAGE_MODE === 'upstash') {
    const res = await fetch(`${UPSTASH_URL}/set/${UPSTASH_DB_KEY}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body: JSON.stringify(db),
    });
    if (!res.ok) throw new Error(`データの保存に失敗しました（ストレージ応答: ${res.status}）`);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export function loadTemplates() {
  return JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
}

export function getTemplate(templates, employmentTypeId) {
  return templates.employmentTypes.find((t) => t.id === (employmentTypeId || DEFAULT_EMPLOYMENT_TYPE));
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

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

export function createEmployee(db, templates, input) {
  const errors = [];
  const template = getTemplate(templates, input.employmentType);
  if (!template) errors.push('雇用区分が不正です');
  if (!input.name || !String(input.name).trim()) errors.push('氏名は必須です');
  if (!isValidDate(input.joinDate)) errors.push('入社日（稼働開始日）は YYYY-MM-DD 形式で指定してください');
  if (input.housingUse && !HOUSING_STATES.includes(input.housingUse)) {
    errors.push(`社宅利用は ${HOUSING_STATES.join(' / ')} のいずれかです`);
  }
  if (errors.length) return { errors };

  const isFulltime = template.id === 'fulltime';
  const employee = {
    id: crypto.randomUUID(),
    portalToken: crypto.randomBytes(16).toString('hex'),
    name: String(input.name).trim(),
    email: String(input.email || '').trim(),
    herpUrl: String(input.herpUrl || '').trim(),
    position: String(input.position || '').trim(),
    department: String(input.department || '').trim(),
    employmentType: template.id,
    joinDate: input.joinDate,
    // 社宅は正社員のみ対象。業務委託は常にnull（UI・集計から除外）
    housingUse: isFulltime ? (input.housingUse || '未確認') : null,
    basicInfo: { address: '', phone: '', bankAccount: '', submittedAt: null },
    source: input.source || 'manual',
    notes: String(input.notes || ''),
    archived: false,
    createdAt: new Date().toISOString(),
    tasks: buildTasks(template, input.joinDate),
  };
  db.employees.push(employee);
  return { employee };
}

export function updateEmployee(db, templates, id, patch) {
  const emp = db.employees.find((e) => e.id === id);
  if (!emp) return { errors: ['対象の従業員が見つかりません'] };

  const isFulltime = (emp.employmentType || DEFAULT_EMPLOYMENT_TYPE) === 'fulltime';
  if (patch.housingUse !== undefined) {
    if (!isFulltime) return { errors: ['業務委託には社宅の設定はありません'] };
    if (!HOUSING_STATES.includes(patch.housingUse)) {
      return { errors: [`社宅利用は ${HOUSING_STATES.join(' / ')} のいずれかです`] };
    }
  }
  if (patch.joinDate !== undefined && !isValidDate(patch.joinDate)) {
    return { errors: ['入社日（稼働開始日）は YYYY-MM-DD 形式で指定してください'] };
  }

  for (const key of ['name', 'email', 'herpUrl', 'position', 'department', 'housingUse', 'notes']) {
    if (patch[key] !== undefined) emp[key] = String(patch[key]);
  }
  if (patch.archived !== undefined) emp.archived = Boolean(patch.archived);

  // 入社日変更時は未完了タスクの期日を再計算する
  if (patch.joinDate !== undefined && patch.joinDate !== emp.joinDate) {
    emp.joinDate = patch.joinDate;
    const template = getTemplate(templates, emp.employmentType);
    const offsets = new Map((template ? template.tasks : []).map((t) => [t.id, t.offsetDays]));
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
export function isTaskApplicable(task, employee) {
  if (task.condition === 'housing') return employee.housingUse !== '利用しない';
  return true;
}

export function progressOf(employee) {
  const applicable = employee.tasks.filter((t) => isTaskApplicable(t, employee));
  const done = applicable.filter((t) => t.status === 'done');
  return { total: applicable.length, done: done.length };
}

// ---- HERP Webhook 連携 ----
// HERPの「採用決定」通知Webhookを受けて自動登録する。
// ペイロードのキー名はHERP側の設定・バージョンで揺れうるため、
// 代表的なキー名を総当たりで探索する（candidate 等のネストにも対応）。

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

const WEBHOOK_KEY_ALIASES = {
  name: ['name', 'candidatename', 'candidate_name', 'fullname', 'full_name', '氏名', '名前', '候補者名'],
  email: ['email', 'mailaddress', 'mail_address', 'mail', 'メールアドレス', 'メール'],
  position: ['position', 'jobposition', 'job_position', 'jobtitle', 'requisition', 'ポジション', '応募ポジション', '求人', '職種'],
  department: ['department', 'division', '部署', '配属部署', '部門'],
  joinDate: ['joindate', 'join_date', 'hiredate', 'hire_date', 'enterdate', 'enter_date', 'entrydate', 'entry_date', '入社日', '入社予定日', '稼働開始日'],
  herpUrl: ['herpurl', 'herp_url', 'candidateurl', 'candidate_url', 'candidatepageurl', '候補者url', '候補者ページurl'],
  employmentType: ['employmenttype', 'employment_type', 'contracttype', 'contract_type', '雇用区分', '雇用形態', '契約形態'],
};

function pickField(obj, aliases) {
  for (const [key, value] of Object.entries(obj)) {
    if (aliases.includes(key.toLowerCase().replace(/[\s_-]/g, '')) || aliases.includes(key.toLowerCase())) {
      if (value !== null && value !== undefined && String(value).trim() !== '') return String(value).trim();
    }
  }
  return '';
}

function normalizeEmploymentType(s) {
  const v = String(s || '').toLowerCase();
  if (v.includes('業務委託') || v.includes('contractor') || v.includes('委託')) return 'contractor';
  return DEFAULT_EMPLOYMENT_TYPE;
}

export function registerFromWebhook(db, templates, payload) {
  if (!payload || typeof payload !== 'object') return { errors: ['ペイロードがJSONオブジェクトではありません'] };
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

  return createEmployee(db, templates, {
    name, email, joinDate,
    herpUrl: pick('herpUrl'),
    position: pick('position'),
    department: pick('department'),
    employmentType: normalizeEmploymentType(pick('employmentType')),
    source: 'herp-webhook',
  });
}

// ---- 本人ページ（ポータル） ----

export function findByPortalToken(db, token) {
  if (!token || typeof token !== 'string') return null;
  return db.employees.find((e) => !e.archived && e.portalToken === token) || null;
}

// 本人に見せる情報だけを抜き出す（人事用メモ・HERP URL等は含めない）
export function portalView(templates, emp) {
  const template = getTemplate(templates, emp.employmentType);
  const myTasks = emp.tasks
    .filter((t) => t.assignee === '本人' && isTaskApplicable(t, emp))
    .map((t) => ({
      id: t.id, title: t.title, description: t.description,
      dueDate: t.dueDate, status: t.status,
    }));
  return {
    name: emp.name,
    joinDate: emp.joinDate,
    joinDateLabel: template ? template.joinDateLabel : '入社日',
    employmentTypeName: template ? template.name : '',
    tasks: myTasks,
    basicInfo: emp.basicInfo || { address: '', phone: '', bankAccount: '', submittedAt: null },
  };
}

// 基礎情報の提出。提出と同時に対応タスク（正社員: info-basic / 業務委託: c-bank）を完了にする
export function submitBasicInfo(db, token, input) {
  const emp = findByPortalToken(db, token);
  if (!emp) return { errors: ['ページが見つかりません。リンクを確認してください'] };
  const address = String(input.address || '').trim();
  const phone = String(input.phone || '').trim();
  const bankAccount = String(input.bankAccount || '').trim();
  if (!address && !phone && !bankAccount) return { errors: ['いずれかの項目を入力してください'] };

  emp.basicInfo = { address, phone, bankAccount, submittedAt: new Date().toISOString() };
  const targetTemplateId = emp.employmentType === 'contractor' ? 'c-bank' : 'info-basic';
  const task = emp.tasks.find((t) => t.templateId === targetTemplateId);
  if (task && task.status !== 'done') {
    task.status = 'done';
    task.completedAt = new Date().toISOString();
  }
  return { employee: emp };
}

// 本人ページからのタスク完了報告（担当が「本人」のタスクのみ操作可能）
export function setPortalTaskStatus(db, token, taskId, status) {
  const emp = findByPortalToken(db, token);
  if (!emp) return { errors: ['ページが見つかりません。リンクを確認してください'] };
  const task = emp.tasks.find((t) => t.id === taskId);
  if (!task || task.assignee !== '本人') return { errors: ['このタスクは操作できません'] };
  if (!['todo', 'done'].includes(status)) return { errors: ['status は todo / done のいずれかです'] };
  task.status = status;
  task.completedAt = status === 'done' ? new Date().toISOString() : null;
  return { employee: emp, task };
}

// ---- Slackデイリーダイジェスト ----

export function buildDigest(db) {
  const today = todayStr();
  const active = db.employees.filter((e) => !e.archived);
  const dueToday = [];
  const overdue = [];
  for (const emp of active) {
    for (const t of emp.tasks) {
      if (t.status === 'done' || !isTaskApplicable(t, emp)) continue;
      if (t.dueDate === today) dueToday.push({ emp, t });
      else if (t.dueDate < today) overdue.push({ emp, t });
    }
  }
  const housingUnknown = active.filter((e) => e.employmentType !== 'contractor' && e.housingUse === '未確認');

  // 本人対応待ち: 本人担当タスクが期限超過 or 期日3日以内で未対応の人（リマインド推奨）
  const remindNeeded = active
    .map((emp) => ({
      emp,
      count: emp.tasks.filter((t) => {
        if (t.assignee !== '本人' || t.status === 'done' || !isTaskApplicable(t, emp)) return false;
        return t.dueDate <= addDays(today, 3);
      }).length,
    }))
    .filter((x) => x.count > 0);

  if (dueToday.length === 0 && overdue.length === 0 && housingUnknown.length === 0 && remindNeeded.length === 0) {
    return { hasItems: false, text: '📋 入社手続き: 本日対応が必要なタスクはありません。' };
  }
  const lines = ['📋 *入社手続き デイリーサマリー*'];
  if (overdue.length) {
    lines.push('', `🔴 *期限超過 ${overdue.length}件*`);
    for (const { emp, t } of overdue.slice(0, 15)) {
      lines.push(`・${emp.name}: ${t.title}（期日 ${t.dueDate} / 担当: ${t.assignee}）`);
    }
    if (overdue.length > 15) lines.push(`・…ほか ${overdue.length - 15}件`);
  }
  if (dueToday.length) {
    lines.push('', `🟡 *本日期日 ${dueToday.length}件*`);
    for (const { emp, t } of dueToday.slice(0, 15)) {
      lines.push(`・${emp.name}: ${t.title}（担当: ${t.assignee}）`);
    }
    if (dueToday.length > 15) lines.push(`・…ほか ${dueToday.length - 15}件`);
  }
  if (housingUnknown.length) {
    lines.push('', `🏠 *社宅利用が未確認: ${housingUnknown.map((e) => e.name).join('、')}*`);
  }
  if (remindNeeded.length) {
    lines.push('', `✉️ *本人対応待ち（リマインド推奨）: ${remindNeeded.map((x) => `${x.emp.name}（${x.count}件）`).join('、')}*`);
    lines.push('ダッシュボードの「✉ リマインド」ボタンからワンクリックで催促メールを作成できます。');
  }
  return { hasItems: true, text: lines.join('\n') };
}
