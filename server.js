import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDb, saveDb, loadTemplate,
  createEmployee, updateEmployee, updateTask, importHerpCsv,
} from './lib/store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
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
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
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

async function handleApi(req, res, url) {
  const db = loadDb();
  const template = loadTemplate();
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // GET /api/template
  if (req.method === 'GET' && url.pathname === '/api/template') {
    return sendJson(res, 200, template);
  }

  // GET /api/employees
  if (req.method === 'GET' && url.pathname === '/api/employees') {
    return sendJson(res, 200, { employees: db.employees });
  }

  // POST /api/employees
  if (req.method === 'POST' && url.pathname === '/api/employees') {
    const input = await readJsonBody(req);
    const { employee, errors } = createEmployee(db, template, input);
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
      const { employee, errors } = updateEmployee(db, template, id, patch);
      if (errors) return sendJson(res, employee === undefined && errors[0].includes('見つかり') ? 404 : 400, { errors });
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

  // POST /api/import/herp  (body: { csv: "..." })
  if (req.method === 'POST' && url.pathname === '/api/import/herp') {
    const input = await readJsonBody(req);
    if (!input.csv) return sendJson(res, 400, { errors: ['csv フィールドにCSVテキストを指定してください'] });
    const result = importHerpCsv(db, template, input.csv);
    if (result.errors) return sendJson(res, 400, { errors: result.errors });
    saveDb(db);
    return sendJson(res, 200, {
      importedCount: result.imported.length,
      imported: result.imported,
      skipped: result.skipped,
    });
  }

  return sendJson(res, 404, { errors: ['APIが見つかりません'] });
}

function serveStatic(res, url) {
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      // SPAのためのフォールバック
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, index) => {
        if (err2) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(index);
      });
      return;
    }
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
});
