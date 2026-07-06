/* 入社手続き管理ツール フロントエンド */

const $app = document.getElementById('app');
let TEMPLATE = null;
let currentFilter = 'active';

// ---------- ユーティリティ ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body.errors || ['通信エラーが発生しました']).join('\n'));
  return body;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysUntil(dateStr) {
  const ms = new Date(dateStr + 'T00:00:00') - new Date(todayStr() + 'T00:00:00');
  return Math.round(ms / 86400000);
}

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${y}/${Number(m)}/${Number(d)}`;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; }, 2600);
}

// サーバー側 isTaskApplicable と同じ判定
function isApplicable(task, emp) {
  if (task.condition === 'housing') return emp.housingUse !== '利用しない';
  return true;
}

function taskStats(emp) {
  const applicable = emp.tasks.filter((t) => isApplicable(t, emp));
  const done = applicable.filter((t) => t.status === 'done').length;
  const overdue = applicable.filter((t) => t.status !== 'done' && daysUntil(t.dueDate) < 0).length;
  const dueSoon = applicable.filter((t) => t.status !== 'done' && daysUntil(t.dueDate) >= 0 && daysUntil(t.dueDate) <= 3).length;
  return { total: applicable.length, done, overdue, dueSoon };
}

function housingBadge(emp) {
  const map = {
    '未確認': ['badge-housing-unknown', '社宅：未確認'],
    '利用する': ['badge-housing-yes', '社宅：利用する'],
    '利用しない': ['badge-housing-no', '社宅：利用しない'],
  };
  const [cls, label] = map[emp.housingUse] || map['未確認'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function ddayHtml(joinDate) {
  const d = daysUntil(joinDate);
  if (d > 0) return `<span class="dday${d <= 7 ? ' soon' : ''}">入社まで ${d}日</span>`;
  if (d === 0) return `<span class="dday soon">本日入社</span>`;
  return `<span class="dday joined">入社済み（${-d}日経過）</span>`;
}

// ---------- ダッシュボード ----------

async function renderDashboard() {
  const { employees } = await api('/api/employees');
  const active = employees.filter((e) => !e.archived);

  const totalOverdue = active.reduce((n, e) => n + taskStats(e).overdue, 0);
  const totalDueSoon = active.reduce((n, e) => n + taskStats(e).dueSoon, 0);
  const upcoming = active.filter((e) => daysUntil(e.joinDate) >= 0).length;
  const housingUnknown = active.filter((e) => e.housingUse === '未確認').length;

  const filters = [
    ['active', 'すべて'],
    ['upcoming', '入社前'],
    ['overdue', '期限超過あり'],
    ['completed', '手続き完了'],
  ];

  let list = active;
  if (currentFilter === 'upcoming') list = active.filter((e) => daysUntil(e.joinDate) >= 0);
  if (currentFilter === 'overdue') list = active.filter((e) => taskStats(e).overdue > 0);
  if (currentFilter === 'completed') list = active.filter((e) => { const s = taskStats(e); return s.done === s.total; });

  list = [...list].sort((a, b) => a.joinDate.localeCompare(b.joinDate));

  $app.innerHTML = `
    <div class="summary-grid">
      <div class="summary-card"><div class="label">入社予定者</div><div class="value">${upcoming}<span style="font-size:13px;color:var(--text-sub)"> 名</span></div></div>
      <div class="summary-card ${totalOverdue ? 'alert' : ''}"><div class="label">期限超過タスク</div><div class="value">${totalOverdue}<span style="font-size:13px;color:var(--text-sub)"> 件</span></div></div>
      <div class="summary-card ${totalDueSoon ? 'warn' : ''}"><div class="label">3日以内に期日</div><div class="value">${totalDueSoon}<span style="font-size:13px;color:var(--text-sub)"> 件</span></div></div>
      <div class="summary-card ${housingUnknown ? 'warn' : ''}"><div class="label">社宅利用が未確認</div><div class="value">${housingUnknown}<span style="font-size:13px;color:var(--text-sub)"> 名</span></div></div>
    </div>

    <div class="section-head">
      <h2>入社者一覧</h2>
      <div class="filter-tabs">
        ${filters.map(([key, label]) => `<button data-filter="${key}" class="${currentFilter === key ? 'active' : ''}">${label}</button>`).join('')}
      </div>
    </div>

    <div class="emp-list">
      ${list.length === 0 ? `
        <div class="empty-state">
          <div class="big">📋</div>
          <p>${active.length === 0
            ? '入社者がまだ登録されていません。<br>右上の「＋ 入社者を登録」または「HERP CSVインポート」から追加してください。'
            : 'この条件に該当する入社者はいません。'}</p>
        </div>` : ''}
      ${list.map((e) => empCardHtml(e)).join('')}
    </div>
  `;

  $app.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentFilter = btn.dataset.filter;
      renderDashboard();
    });
  });
}

function empCardHtml(e) {
  const s = taskStats(e);
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const complete = s.done === s.total;
  return `
    <a class="emp-card" href="#/emp/${e.id}">
      <div>
        <div class="emp-name">${esc(e.name)}</div>
        <div class="emp-meta">${esc([e.position, e.department].filter(Boolean).join(' / ') || '—')}</div>
      </div>
      <div class="emp-join">
        <div class="date">入社日 ${fmtDate(e.joinDate)}</div>
        ${ddayHtml(e.joinDate)}
      </div>
      <div>${housingBadge(e)}</div>
      <div class="progress-wrap">
        <div class="progress-bar"><div class="${complete ? 'complete' : ''}" style="width:${pct}%"></div></div>
        <span class="progress-label">${s.done}/${s.total}${complete ? ' ✅' : ''}</span>
      </div>
      <div class="emp-alert">
        ${s.overdue ? `<span class="badge badge-overdue">期限超過 ${s.overdue}件</span>` : ''}
        ${!s.overdue && s.dueSoon ? `<span class="badge badge-soon">期日間近 ${s.dueSoon}件</span>` : ''}
        ${!s.overdue && !s.dueSoon && complete ? `<span class="badge badge-done">完了</span>` : ''}
      </div>
    </a>
  `;
}

// ---------- 詳細ページ ----------

async function renderDetail(id) {
  let emp;
  try {
    ({ employee: emp } = await api(`/api/employees/${id}`));
  } catch {
    location.hash = '#/';
    return;
  }

  const s = taskStats(emp);
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;

  const phasesHtml = TEMPLATE.phases.map((phase) => {
    const tasks = emp.tasks.filter((t) => t.phaseId === phase.id);
    if (tasks.length === 0) return '';
    const applicable = tasks.filter((t) => isApplicable(t, emp));
    const done = applicable.filter((t) => t.status === 'done').length;
    const complete = applicable.length > 0 && done === applicable.length;
    return `
      <section class="phase">
        <div class="phase-head">
          <h3>${esc(phase.name)}<span class="desc">${esc(phase.description)}</span></h3>
          <span class="phase-count ${complete ? 'complete' : ''}">${done}/${applicable.length}${complete ? ' 完了 ✅' : ''}</span>
        </div>
        ${tasks.map((t) => taskHtml(t, emp)).join('')}
      </section>
    `;
  }).join('');

  $app.innerHTML = `
    <a class="back-link" href="#/">← 一覧に戻る</a>
    <div class="detail-header">
      <div class="detail-header-top">
        <div>
          <h1 class="detail-name">${esc(emp.name)}</h1>
          <div class="emp-meta">${esc(emp.email || '')}</div>
        </div>
        <button class="btn btn-danger-ghost" id="btn-delete">削除</button>
      </div>
      <div class="detail-fields">
        <div class="detail-field"><label>入社日</label><input type="date" data-field="joinDate" value="${esc(emp.joinDate)}"></div>
        <div class="detail-field"><label>ポジション</label><input data-field="position" value="${esc(emp.position)}"></div>
        <div class="detail-field"><label>部署</label><input data-field="department" value="${esc(emp.department)}"></div>
        <div class="detail-field"><label>社宅利用</label>
          <select data-field="housingUse">
            ${['未確認', '利用する', '利用しない'].map((v) => `<option ${emp.housingUse === v ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      ${emp.housingUse === '未確認' ? `<div class="housing-hint">⚠ 社宅利用の有無が未確認です。確認して更新すると、社宅関連タスクの要否が自動で切り替わります。</div>` : ''}
      <div class="detail-progress progress-wrap">
        <div class="progress-bar"><div class="${s.done === s.total ? 'complete' : ''}" style="width:${pct}%"></div></div>
        <span class="progress-label">全体進捗 ${s.done}/${s.total}（${pct}%）</span>
        ${s.overdue ? `<span class="badge badge-overdue">期限超過 ${s.overdue}件</span>` : ''}
      </div>
      <div class="detail-notes">
        <label style="font-size:11px;color:var(--text-sub)">メモ（オファー条件・特記事項など）</label>
        <textarea data-field="notes" rows="2" placeholder="例）年収◯◯万円 / リモート中心 / 前職の源泉徴収票は12月に受領予定">${esc(emp.notes)}</textarea>
      </div>
    </div>
    ${phasesHtml}
  `;

  // フィールドの自動保存
  $app.querySelectorAll('[data-field]').forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        await api(`/api/employees/${emp.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ [input.dataset.field]: input.value }),
        });
        toast('保存しました');
        renderDetail(emp.id);
      } catch (err) {
        toast(err.message);
      }
    });
  });

  // タスクのチェック
  $app.querySelectorAll('[data-task]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      try {
        await api(`/api/employees/${emp.id}/tasks/${cb.dataset.task}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: cb.checked ? 'done' : 'todo' }),
        });
        renderDetail(emp.id);
      } catch (err) {
        toast(err.message);
        cb.checked = !cb.checked;
      }
    });
  });

  // 期日の変更
  $app.querySelectorAll('[data-task-due]').forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        await api(`/api/employees/${emp.id}/tasks/${input.dataset.taskDue}`, {
          method: 'PATCH',
          body: JSON.stringify({ dueDate: input.value }),
        });
        toast('期日を変更しました');
        renderDetail(emp.id);
      } catch (err) {
        toast(err.message);
      }
    });
  });

  document.getElementById('btn-delete').addEventListener('click', async () => {
    if (!confirm(`${emp.name} さんのデータを削除します。よろしいですか？`)) return;
    await api(`/api/employees/${emp.id}`, { method: 'DELETE' });
    toast('削除しました');
    location.hash = '#/';
  });
}

function taskHtml(t, emp) {
  const applicable = isApplicable(t, emp);
  const days = daysUntil(t.dueDate);
  let dueBadge = '';
  if (applicable && t.status !== 'done') {
    if (days < 0) dueBadge = `<span class="badge badge-overdue">${-days}日超過</span>`;
    else if (days <= 3) dueBadge = `<span class="badge badge-soon">あと${days}日</span>`;
  }
  const housingNote = t.condition === 'housing' && emp.housingUse === '未確認'
    ? `<span class="badge badge-housing-unknown">社宅利用が確認でき次第</span>` : '';

  return `
    <div class="task ${t.status === 'done' ? 'done' : ''} ${applicable ? '' : 'inapplicable'}">
      <input type="checkbox" data-task="${t.id}" ${t.status === 'done' ? 'checked' : ''} ${applicable ? '' : 'disabled'}>
      <div class="task-main">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-desc">${esc(t.description)}</div>
      </div>
      <div class="task-badges">
        ${housingNote}
        ${applicable ? '' : '<span class="badge badge-housing-no">対象外（社宅利用なし）</span>'}
        <span class="badge badge-assignee">${esc(t.assignee)}</span>
        ${dueBadge}
        ${applicable
          ? `<input class="due-input" type="date" data-task-due="${t.id}" value="${esc(t.dueDate)}" title="期日を変更">`
          : ''}
      </div>
    </div>
  `;
}

// ---------- モーダル ----------

function setupDialogs() {
  const dlgAdd = document.getElementById('dialog-add');
  const dlgImport = document.getElementById('dialog-import');

  document.getElementById('btn-add').addEventListener('click', () => {
    document.getElementById('form-add').reset();
    document.getElementById('add-error').textContent = '';
    dlgAdd.showModal();
  });
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('form-import').reset();
    document.getElementById('import-result').innerHTML = '';
    dlgImport.showModal();
  });
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  });

  document.getElementById('form-add').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const { employee } = await api('/api/employees', { method: 'POST', body: JSON.stringify(data) });
      dlgAdd.close();
      toast(`${employee.name} さんを登録し、${employee.tasks.length}件のタスクを生成しました`);
      location.hash = `#/emp/${employee.id}`;
      route();
    } catch (err) {
      document.getElementById('add-error').textContent = err.message;
    }
  });

  document.getElementById('form-import').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fileInput = document.getElementById('import-file');
    const textInput = document.getElementById('import-text');
    const resultEl = document.getElementById('import-result');
    let csv = textInput.value.trim();
    if (fileInput.files[0]) csv = await fileInput.files[0].text();
    if (!csv) {
      resultEl.innerHTML = '<p class="form-error">CSVファイルを選択するか、CSVテキストを貼り付けてください。</p>';
      return;
    }
    try {
      const result = await api('/api/import/herp', { method: 'POST', body: JSON.stringify({ csv }) });
      resultEl.innerHTML = `
        <p class="ok">✅ ${result.importedCount}名をインポートしました。</p>
        ${result.skipped.length ? `<p>スキップ ${result.skipped.length}件：</p>
          <ul>${result.skipped.map((s) => `<li>${s.line}行目：${esc(s.reason)}</li>`).join('')}</ul>` : ''}
      `;
      if (result.importedCount > 0) renderDashboard();
    } catch (err) {
      resultEl.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    }
  });
}

// ---------- ルーティング ----------

function route() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/emp\/(.+)$/);
  if (m) renderDetail(m[1]);
  else renderDashboard();
}

window.addEventListener('hashchange', route);

(async function init() {
  TEMPLATE = await api('/api/template');
  setupDialogs();
  route();
})();
