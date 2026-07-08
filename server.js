import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDb, saveDb, loadTemplates,
  createEmployee, updateEmployee, updateTask, registerFromWebhook,
  findByPortalToken, portalView, submitBasicInfo, setPortalTaskStatus,
  buildDigest, todayStr,
} from './lib/store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) reject(new Error('リクエストが大きすぎます'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

// ---- Slack通知 ----

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendSlackDigest({ force = false } = {}) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return { ok: false, reason: 'SLACK_WEBHOOK_URL が設定されていません' };
  const digest = buildDigest(loadDb());
  if (!digest.hasItems && !force) return { ok: true, skipped: true, reason: '通知対象がありません' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: digest.text }),
  });
  if (!res.ok) return { ok: false, reason: `Slack応答: ${res.status}` };
  return { ok: true, text: digest.text };
}

// 毎朝9時台に1回だけデイリーダイジェストを送る（10分間隔でチェック）
const DIGEST_HOUR = Number(process.env.DIGEST_HOUR || 9);
function startDigestScheduler() {
  setInterval(async () => {
    if (!process.env.SLACK_WEBHOOK_URL) return;
    const now = new Date();
    if (now.getHours() !== DIGEST_HOUR) return;
    const state = loadState();
    if (state.lastDigestDate === todayStr()) return;
    try {
      const result = await sendSlackDigest();
      if (result.ok) {
        state.lastDigestDate = todayStr();
        saveState(state);
        console.log('[slack] デイリーダイジェストを送信しました');
      } else {
        console.error('[slack] 送信失敗:', result.reason);
      }
    } catch (err) {
      console.error('[slack] 送信エラー:', err.message);
    }
  }, 10 * 60 * 1000).unref();
}

// ---- APIルーティング ----

async function handleApi(req, res, url) {
  const db = loadDb();
  const templates = loadTemplates();
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // GET /api/templates
  if (req.method === 'GET' && url.pathname === '/api/templates') {
    return sendJson(res, 200, templates);
  }

  // GET /api/employees
  if (req.method === 'GET' && url.pathname === '/api/employees') {
    return sendJson(res, 200, { employees: db.employees });
  }

  // POST /api/employees
  if (req.method === 'POST' && url.pathname === '/api/employees') {
    const input = await readJsonBody(req);
    const { employee, errors } = createEmployee(db, templates, input);
    if (errors) return sendJson(res, 400, { errors });
    saveDb(db);
    return sendJson(res, 201, { employee });
  }

  // /api/employees/:id
  if (parts[1] === 'employees' && parts[2] && parts.length === 3) {
    const id = parts[2];
    if (req.method === 'GET') {
      const emp = db.employees.find((e) => e.id === id);
      if (!emp) return sendJson(res, 404, { errors: ['対象の従業員が見つかりません'] });
      return sendJson(res, 200, { employee: emp });
    }
    if (req.method === 'PATCH') {
      const patch = await readJsonBody(req);
      const { employee, errors } = updateEmployee(db, templates, id, patch);
      if (errors) return sendJson(res, errors[0].includes('見つかり') ? 404 : 400, { errors });
      saveDb(db);
      return sendJson(res, 200, { employee });
    }
    if (req.method === 'DELETE') {
      const idx = db.employees.findIndex((e) => e.id === id);
      if (idx < 0) return sendJson(res, 404, { errors: ['対象の従業員が見つかりません'] });
      db.employees.splice(idx, 1);
      saveDb(db);
      return sendJson(res, 200, { ok: true });
    }
  }

  // PATCH /api/employees/:id/tasks/:taskId
  if (req.method === 'PATCH' && parts[1] === 'employees' && parts[3] === 'tasks' && parts[4]) {
    const patch = await readJsonBody(req);
    const { employee, errors } = updateTask(db, parts[2], parts[4], patch);
    if (errors) return sendJson(res, errors[0].includes('見つかり') ? 404 : 400, { errors });
    saveDb(db);
    return sendJson(res, 200, { employee });
  }

  // POST /api/webhook/herp — HERPの採用決定Webhookを受けて自動登録する
  if (req.method === 'POST' && url.pathname === '/api/webhook/herp') {
    const expected = process.env.HERP_WEBHOOK_TOKEN;
    if (expected) {
      const got = url.searchParams.get('token') || req.headers['x-webhook-token'];
      if (got !== expected) return sendJson(res, 401, { errors: ['認証トークンが一致しません'] });
    }
    const payload = await readJsonBody(req);
    const result = registerFromWebhook(db, templates, payload);
    if (result.errors) return sendJson(res, 400, { errors: result.errors });
    if (result.duplicate) {
      return sendJson(res, 200, { ok: true, duplicate: true, message: `既に登録済みです（${result.duplicate.name}）` });
    }
    saveDb(db);
    console.log(`[webhook] ${result.employee.name}（${result.employee.joinDate}）を自動登録しました`);
    return sendJson(res, 201, { ok: true, employee: result.employee });
  }

  // ---- 本人ページAPI（トークン認証） ----

  // GET /api/portal/:token
  if (req.method === 'GET' && parts[1] === 'portal' && parts[2] && parts.length === 3) {
    const emp = findByPortalToken(db, parts[2]);
    if (!emp) return sendJson(res, 404, { errors: ['ページが見つかりません。リンクを確認してください'] });
    return sendJson(res, 200, portalView(templates, emp));
  }

  // POST /api/portal/:token/basic-info
  if (req.method === 'POST' && parts[1] === 'portal' && parts[3] === 'basic-info') {
    const input = await readJsonBody(req);
    const { errors } = submitBasicInfo(db, parts[2], input);
    if (errors) return sendJson(res, errors[0].includes('見つかり') ? 404 : 400, { errors });
    saveDb(db);
    const emp = findByPortalToken(db, parts[2]);
    return sendJson(res, 200, portalView(templates, emp));
  }

  // PATCH /api/portal/:token/tasks/:taskId
  if (req.method === 'PATCH' && parts[1] === 'portal' && parts[3] === 'tasks' && parts[4]) {
    const patch = await readJsonBody(req);
    const { errors } = setPortalTaskStatus(db, parts[2], parts[4], patch.status);
    if (errors) return sendJson(res, errors[0].includes('見つかり') ? 404 : 400, { errors });
    saveDb(db);
    const emp = findByPortalToken(db, parts[2]);
    return sendJson(res, 200, portalView(templates, emp));
  }

  // POST /api/notify/slack — デイリーダイジェストを今すぐ送信（動作確認用）
  if (req.method === 'POST' && url.pathname === '/api/notify/slack') {
    const result = await sendSlackDigest({ force: true });
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  // GET /api/notify/preview — 通知内容のプレビュー（Slack未設定でも確認できる）
  if (req.method === 'GET' && url.pathname === '/api/notify/preview') {
    return sendJson(res, 200, buildDigest(db));
  }

  return sendJson(res, 404, { errors: ['APIが見つかりません'] });
}

function serveFile(res, absPath) {
  fs.readFile(absPath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(absPath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveStatic(res, url) {
  // 本人ページ: /portal/:token
  if (/^\/portal\/[0-9a-f]+$/.test(url.pathname)) {
    return serveFile(res, path.join(PUBLIC_DIR, 'portal.html'));
  }
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(abs, (err, data) => {
    if (err) return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(res, url);
    }
  } catch (err) {
    const isSyntax = err instanceof SyntaxError;
    sendJson(res, isSyntax ? 400 : 500, { errors: [isSyntax ? 'JSONの形式が不正です' : String(err.message || err)] });
  }
});

server.listen(PORT, () => {
  console.log(`入社手続き管理ツール: http://localhost:${PORT}`);
  if (process.env.SLACK_WEBHOOK_URL) {
    console.log(`Slackデイリー通知: 毎日${DIGEST_HOUR}時台に送信します`);
  } else {
    console.log('Slackデイリー通知: SLACK_WEBHOOK_URL 未設定のため無効です');
  }
  startDigestScheduler();
});
