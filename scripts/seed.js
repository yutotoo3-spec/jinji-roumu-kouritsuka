// デモデータを投入するスクリプト。動作確認用: `npm run seed`
import { loadDb, saveDb, loadTemplates, createEmployee, updateTask, submitBasicInfo, addDays, todayStr } from '../lib/store.js';

const db = loadDb();
const templates = loadTemplates();

if (db.employees.length > 0) {
  console.log('既にデータが存在するため、デモデータの投入をスキップしました。');
  console.log('投入し直す場合は data/db.json を削除してください。');
  process.exit(0);
}

const t = todayStr();

const samples = [
  {
    name: '佐藤 花子',
    email: 'hanako.sato@example.com',
    position: 'ソフトウェアエンジニア',
    department: '開発部',
    joinDate: addDays(t, 21),
    housingUse: '利用する',
    herpUrl: 'https://agent.herp.cloud/p/candidates/demo-hanako',
    doneCount: 6,
  },
  {
    name: '鈴木 一郎',
    email: 'ichiro.suzuki@example.com',
    position: 'セールス',
    department: '営業部',
    joinDate: addDays(t, 10),
    housingUse: '未確認',
    doneCount: 3,
  },
  {
    name: '高橋 美咲',
    email: 'misaki.takahashi@example.com',
    position: 'カスタマーサクセス',
    department: 'CS部',
    joinDate: addDays(t, -3),
    housingUse: '利用しない',
    doneCount: 20,
  },
  {
    name: '中村 蓮',
    email: 'ren.nakamura@example.com',
    position: 'UIデザイナー（業務委託）',
    department: '開発部',
    joinDate: addDays(t, 14),
    employmentType: 'contractor',
    doneCount: 4,
  },
];

for (const sample of samples) {
  const { doneCount, ...input } = sample;
  const { employee, errors } = createEmployee(db, templates, { ...input, source: 'manual' });
  if (errors) {
    console.error(`投入失敗（${input.name}）:`, errors.join(', '));
    continue;
  }
  for (const task of employee.tasks.slice(0, doneCount)) {
    updateTask(db, employee.id, task.id, { status: 'done' });
  }
  console.log(`✅ ${employee.name}（${employee.joinDate} / ${employee.employmentType}）を登録しました`);
}

// 1人目は基礎情報提出済みのデモにする
const first = db.employees[0];
if (first) {
  submitBasicInfo(db, first.portalToken, {
    address: '〒150-0001 東京都渋谷区神宮前1-2-3',
    phone: '090-1234-5678',
    bankAccount: 'みずほ銀行 渋谷支店 普通 1234567 サトウ ハナコ',
  });
}

saveDb(db);
console.log('デモデータの投入が完了しました。npm start でサーバーを起動してください。');
