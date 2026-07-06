// デモデータを投入するスクリプト。動作確認用: `npm run seed`
import { loadDb, saveDb, loadTemplate, createEmployee, updateTask, addDays } from '../lib/store.js';

const db = loadDb();
const template = loadTemplate();

if (db.employees.length > 0) {
  console.log('既にデータが存在するため、デモデータの投入をスキップしました。');
  console.log('投入し直す場合は data/db.json を削除してください。');
  process.exit(0);
}

const today = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const samples = [
  {
    name: '佐藤 花子',
    email: 'hanako.sato@example.com',
    position: 'ソフトウェアエンジニア',
    department: '開発部',
    joinDate: addDays(iso(today), 21),
    housingUse: '利用する',
    doneCount: 6,
  },
  {
    name: '鈴木 一郎',
    email: 'ichiro.suzuki@example.com',
    position: 'セールス',
    department: '営業部',
    joinDate: addDays(iso(today), 10),
    housingUse: '未確認',
    doneCount: 3,
  },
  {
    name: '高橋 美咲',
    email: 'misaki.takahashi@example.com',
    position: 'カスタマーサクセス',
    department: 'CS部',
    joinDate: addDays(iso(today), -3),
    housingUse: '利用しない',
    doneCount: 18,
  },
];

for (const sample of samples) {
  const { doneCount, ...input } = sample;
  const { employee, errors } = createEmployee(db, template, { ...input, source: 'manual' });
  if (errors) {
    console.error(`投入失敗（${input.name}）:`, errors.join(', '));
    continue;
  }
  for (const task of employee.tasks.slice(0, doneCount)) {
    updateTask(db, employee.id, task.id, { status: 'done' });
  }
  console.log(`✅ ${employee.name}（入社日 ${employee.joinDate}）を登録しました`);
}

saveDb(db);
console.log('デモデータの投入が完了しました。npm start でサーバーを起動してください。');
