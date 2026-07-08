/* 入社手続き管理ツール フロントエンド */

const $app = document.getElementById('app');
let TEMPLATES = null;
let currentFilter = 'active';
let currentTypeFilter = 'all';

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

function fmtDateJa(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; }, 2600);
}

function tplOf(emp) {
  return TEMPLATES.employmentTypes.find((t) => t.id === (emp.employmentType || 'fulltime'))
    || TEMPLATES.employmentTypes[0];
}

function isFulltime(emp) {
  return tplOf(emp).id === 'fulltime';
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

function typeBadge(emp) {
  const tpl = tplOf(emp);
  const cls = tpl.id === 'contractor' ? 'badge-type-ct' : 'badge-type-ft';
  return `<span class="badge ${cls}">${esc(tpl.name)}</span>`;
}

function housingBadge(emp) {
  if (!isFulltime(emp)) return '';
  const map = {
    '未確認': ['badge-housing-unknown', '社宅：未確認'],
    '利用する': ['badge-housing-yes', '社宅：利用する'],
    '利用しない': ['badge-housing-no', '社宅：利用しない'],
  };
  const [cls, label] = map[emp.housingUse] || map['未確認'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function ddayHtml(emp) {
  const d = daysUntil(emp.joinDate);
  const label = tplOf(emp).joinDateLabel;
  if (d > 0) return `<span class="dday${d <= 7 ? ' soon' : ''}">${esc(label)}まで ${d}日</span>`;
  if (d === 0) return `<span class="dday soon">本日${esc(label)}</span>`;
  return `<span class="dday joined">稼働中（${-d}日経過）</span>`;
}

// ---------- ダッシュボード ----------

async function renderDashboard() {
  const { employees } = await api('/api/employees');
  const active = employees.filter((e) => !e.archived);

  const totalOverdue = active.reduce((n, e) => n + taskStats(e).overdue, 0);
  const totalDueSoon = active.reduce((n, e) => n + taskStats(e).dueSoon, 0);
  const upcoming = active.filter((e) => daysUntil(e.joinDate) >= 0).length;
  const housingUnknown = active.filter((e) => isFulltime(e) && e.housingUse === '未確認').length;

  const filters = [
    ['active', 'すべて'],
    ['upcoming', '受け入れ前'],
    ['overdue', '期限超過あり'],
    ['completed', '手続き完了'],
  ];

  let list = active;
  if (currentFilter === 'upcoming') list = list.filter((e) => daysUntil(e.joinDate) >= 0);
  if (currentFilter === 'overdue') list = list.filter((e) => taskStats(e).overdue > 0);
  if (currentFilter === 'completed') list = list.filter((e) => { const s = taskStats(e); return s.done === s.total; });
  if (currentTypeFilter !== 'all') list = list.filter((e) => (e.employmentType || 'fulltime') === currentTypeFilter);

  list = [...list].sort((a, b) => a.joinDate.localeCompare(b.joinDate));

  $app.innerHTML = `
    <div class="summary-grid">
      <div class="summary-card"><div class="label">受け入れ予定</div><div class="value">${upcoming}<span class="unit"> 名</span></div></div>
      <div class="summary-card ${totalOverdue ? 'alert' : ''}"><div class="label">期限超過タスク</div><div class="value">${totalOverdue}<span class="unit"> 件</span></div></div>
      <div class="summary-card ${totalDueSoon ? 'warn' : ''}"><div class="label">3日以内に期日</div><div class="value">${totalDueSoon}<span class="unit"> 件</span></div></div>
      <div class="summary-card ${housingUnknown ? 'warn' : ''}"><div class="label">社宅利用が未確認</div><div class="value">${housingUnknown}<span class="unit"> 名</span></div></div>
    </div>

    <div class="section-head">
      <h2>受け入れ一覧</h2>
      <div class="section-tools">
        <select id="type-filter" title="雇用区分で絞り込み">
          <option value="all" ${currentTypeFilter === 'all' ? 'selected' : ''}>全区分</option>
          ${TEMPLATES.employmentTypes.map((t) => `<option value="${t.id}" ${currentTypeFilter === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>
        <div class="filter-tabs">
          ${filters.map(([key, label]) => `<button data-filter="${key}" class="${currentFilter === key ? 'active' : ''}">${label}</button>`).join('')}
        </div>
        <button class="btn btn-secondary btn-sm" id="btn-export-mf" title="基礎情報をマネーフォワード取込用CSVでダウンロード">MF取込CSV</button>
      </div>
    </div>

    <div class="emp-list">
      ${list.length === 0 ? `
        <div class="empty-state">
          <div class="big">📋</div>
          <p>${active.length === 0
            ? '登録がまだありません。<br>右上の「＋ 入社者を登録」から追加するか、HERPのWebhook連携を設定してください。'
            : 'この条件に該当する人はいません。'}</p>
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
  document.getElementById('type-filter').addEventListener('change', (ev) => {
    currentTypeFilter = ev.target.value;
    renderDashboard();
  });
  document.getElementById('btn-export-mf').addEventListener('click', () => exportMfCsv(active));
}

function empCardHtml(e) {
  const s = taskStats(e);
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const complete = s.done === s.total;
  const joinLabel = tplOf(e).joinDateLabel;
  return `
    <a class="emp-card" href="#/emp/${e.id}">
      <div>
        <div class="emp-name">${esc(e.name)}</div>
        <div class="emp-meta">${esc([e.position, e.department].filter(Boolean).join(' / ') || '—')}</div>
      </div>
      <div class="emp-join">
        <div class="date">${esc(joinLabel)} ${fmtDate(e.joinDate)}</div>
        ${ddayHtml(e)}
      </div>
      <div class="emp-badges">${typeBadge(e)} ${housingBadge(e)}</div>
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

// ---------- マネーフォワード取込CSV ----------

function csvField(s) {
  const v = String(s ?? '');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function exportMfCsv(employees) {
  if (employees.length === 0) { toast('出力対象がありません'); return; }
  const header = ['氏名', 'メールアドレス', '雇用区分', '部署', 'ポジション', '入社日（稼働開始日）', '住所', '電話番号', '振込口座', '社宅利用'];
  const rows = employees.map((e) => [
    e.name, e.email, tplOf(e).name, e.department, e.position, e.joinDate,
    e.basicInfo?.address || '', e.basicInfo?.phone || '', e.basicInfo?.bankAccount || '',
    isFulltime(e) ? (e.housingUse || '') : '',
  ]);
  const csv = '﻿' + [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mf-import-${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('CSVをダウンロードしました。マネーフォワードの取込画面で項目を対応付けてください');
}

// ---------- メール文面の差し込み生成 ----------

function portalUrl(emp) {
  return `${location.origin}/portal/${emp.portalToken}`;
}

function pendingSelfTasks(emp) {
  return emp.tasks
    .filter((t) => t.assignee === '本人' && t.status !== 'done' && isApplicable(t, emp))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function mailTemplates(emp) {
  const tpl = tplOf(emp);
  const joinLabel = tpl.joinDateLabel;
  const items = pendingSelfTasks(emp)
    .map((t) => `・${t.title}（${fmtDateJa(t.dueDate)}まで）`)
    .join('\n');
  const signature = '\n──────────\n[会社名] 人事担当\n[担当者名] / [連絡先]';
  const portal = `▼あなた専用の手続きページ（提出状況の確認・基礎情報の提出ができます）\n${portalUrl(emp)}`;

  const list = [];
  if (tpl.id === 'fulltime') {
    list.push({
      id: 'guide',
      name: '入社手続きのご案内',
      subject: `【${fmtDateJa(emp.joinDate)}入社】入社手続きのご案内`,
      body: `${emp.name} 様\n\nこの度はご入社いただくことになり、大変嬉しく思っております。\n入社日（${fmtDateJa(emp.joinDate)}）に向けて、以下のご対応をお願いいたします。\n\n${items || '（現在ご対応いただく項目はありません）'}\n\n${portal}\n\nご不明な点があれば、お気軽にご連絡ください。\n当日お会いできることを楽しみにしております。${signature}`,
    });
    if (emp.housingUse === '未確認') {
      list.push({
        id: 'housing',
        name: '社宅利用確認のご案内',
        subject: '社宅制度のご案内と利用希望の確認',
        body: `${emp.name} 様\n\n当社には社宅制度があります。ご利用を希望される場合は物件の手配を進めますので、【${fmtDateJa(addDaysStr(emp.joinDate, -14))}まで】に利用希望の有無をご返信ください。\n\n・自己負担額や入居条件の詳細は、添付の社宅規程をご確認ください\n・ご希望のエリア・間取りがあれば併せてお知らせください${signature}`,
      });
    }
    list.push({
      id: 'remind',
      name: '提出書類のリマインド',
      subject: '【リマインド】入社書類のご提出のお願い',
      body: `${emp.name} 様\n\n入社日が近づいてまいりました。以下の書類・情報がまだご提出いただけていないようですので、ご確認をお願いいたします。\n\n${items || '（未提出の項目はありません）'}\n\n${portal}\n\nすでにご対応済みでしたら行き違いご容赦ください。${signature}`,
    });
  } else {
    list.push({
      id: 'c-guide',
      name: '契約手続きのご案内',
      subject: `【${fmtDateJa(emp.joinDate)}稼働開始】ご契約手続きのご案内`,
      body: `${emp.name} 様\n\nこの度は業務をお受けいただきありがとうございます。\n稼働開始日（${fmtDateJa(emp.joinDate)}）に向けて、以下のご対応をお願いいたします。\n\n${items || '（現在ご対応いただく項目はありません）'}\n\n${portal}\n\n請求書の締め日・お支払サイトなどの条件は契約書に記載しております。\nご不明な点があれば、お気軽にご連絡ください。${signature}`,
    });
    list.push({
      id: 'c-remind',
      name: '提出物のリマインド',
      subject: '【リマインド】ご提出物のお願い',
      body: `${emp.name} 様\n\n稼働開始日が近づいてまいりました。以下がまだご提出いただけていないようですので、ご確認をお願いいたします。\n\n${items || '（未提出の項目はありません）'}\n\n${portal}\n\nすでにご対応済みでしたら行き違いご容赦ください。${signature}`,
    });
  }
  return list;
}

function addDaysStr(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
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

  const tpl = tplOf(emp);
  const ft = isFulltime(emp);
  const s = taskStats(emp);
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const mails = mailTemplates(emp);

  const phasesHtml = tpl.phases.map((phase) => {
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

  const info = emp.basicInfo || {};

  $app.innerHTML = `
    <a class="back-link" href="#/">← 一覧に戻る</a>
    <div class="detail-header">
      <div class="detail-header-top">
        <div>
          <h1 class="detail-name">${esc(emp.name)} ${typeBadge(emp)}</h1>
          <div class="emp-meta">${esc(emp.email || '')}${/^https?:\/\//.test(emp.herpUrl || '') ? `${emp.email ? ' ・ ' : ''}<a class="herp-link" href="${esc(emp.herpUrl)}" target="_blank" rel="noopener">HERPで開く ↗</a>` : ''}</div>
        </div>
        <button class="btn btn-danger-ghost" id="btn-delete">削除</button>
      </div>
      <div class="detail-fields">
        <div class="detail-field"><label>${esc(tpl.joinDateLabel)}</label><input type="date" data-field="joinDate" value="${esc(emp.joinDate)}"></div>
        <div class="detail-field"><label>ポジション</label><input data-field="position" value="${esc(emp.position)}"></div>
        <div class="detail-field"><label>部署</label><input data-field="department" value="${esc(emp.department)}"></div>
        ${ft ? `
        <div class="detail-field"><label>社宅利用</label>
          <select data-field="housingUse">
            ${['未確認', '利用する', '利用しない'].map((v) => `<option ${emp.housingUse === v ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>` : ''}
        <div class="detail-field"><label>HERP候補者URL（任意）</label><input type="url" data-field="herpUrl" value="${esc(emp.herpUrl || '')}" placeholder="https://agent.herp.cloud/..."></div>
      </div>
      ${ft && emp.housingUse === '未確認' ? `<div class="housing-hint">⚠ 社宅利用の有無が未確認です。確認して更新すると、社宅関連タスクの要否が自動で切り替わります。</div>` : ''}
      <div class="detail-progress progress-wrap">
        <div class="progress-bar"><div class="${s.done === s.total ? 'complete' : ''}" style="width:${pct}%"></div></div>
        <span class="progress-label">全体進捗 ${s.done}/${s.total}（${pct}%）</span>
        ${s.overdue ? `<span class="badge badge-overdue">期限超過 ${s.overdue}件</span>` : ''}
      </div>
      <div class="detail-notes">
        <label for="notes-input">メモ（オファー条件・特記事項など）</label>
        <textarea id="notes-input" data-field="notes" rows="2" placeholder="例）年収◯◯万円 / リモート中心 / 前職の源泉徴収票は12月に受領予定">${esc(emp.notes)}</textarea>
      </div>
    </div>

    <section class="tool-box">
      <div class="tool-box-head">
        <h3>🔗 本人ページ</h3>
        <p>本人に共有する専用URLです。提出物の確認と基礎情報の提出ができます。案内メールに貼り付けて送ってください。</p>
      </div>
      <div class="portal-row">
        <input type="text" readonly value="${esc(portalUrl(emp))}" id="portal-url">
        <button class="btn btn-secondary btn-sm" id="btn-copy-portal">コピー</button>
        <a class="btn btn-secondary btn-sm" href="${esc(portalUrl(emp))}" target="_blank" rel="noopener">開いて確認</a>
      </div>
      ${info.submittedAt ? `
      <div class="basic-info-view">
        <strong>本人から提出された基礎情報</strong>（${new Date(info.submittedAt).toLocaleString('ja-JP')}）
        <table>
          <tr><th>住所</th><td>${esc(info.address || '—')}</td></tr>
          <tr><th>電話番号</th><td>${esc(info.phone || '—')}</td></tr>
          <tr><th>振込口座</th><td>${esc(info.bankAccount || '—')}</td></tr>
        </table>
      </div>` : '<p class="portal-note">基礎情報はまだ提出されていません。</p>'}
    </section>

    <section class="tool-box">
      <div class="tool-box-head">
        <h3>✉️ メール文面の生成</h3>
        <p>氏名・期日・提出物一覧・本人ページURLを差し込んだ文面を作ります。[会社名] などの部分は送信前に置き換えてください。</p>
      </div>
      <div class="mail-row">
        <select id="mail-select">
          ${mails.map((m, i) => `<option value="${i}">${esc(m.name)}</option>`).join('')}
        </select>
        <button class="btn btn-secondary btn-sm" id="btn-copy-mail">本文をコピー</button>
        <button class="btn btn-secondary btn-sm" id="btn-copy-subject">件名をコピー</button>
      </div>
      <textarea id="mail-body" rows="10" readonly></textarea>
    </section>

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

  // 本人ページURLコピー
  document.getElementById('btn-copy-portal').addEventListener('click', async () => {
    toast(await copyText(portalUrl(emp)) ? '本人ページのURLをコピーしました' : 'コピーできませんでした');
  });

  // メール文面
  const mailSelect = document.getElementById('mail-select');
  const mailBody = document.getElementById('mail-body');
  const updateMail = () => { mailBody.value = mails[Number(mailSelect.value)].body; };
  mailSelect.addEventListener('change', updateMail);
  updateMail();
  document.getElementById('btn-copy-mail').addEventListener('click', async () => {
    toast(await copyText(mails[Number(mailSelect.value)].body) ? '本文をコピーしました' : 'コピーできませんでした');
  });
  document.getElementById('btn-copy-subject').addEventListener('click', async () => {
    toast(await copyText(mails[Number(mailSelect.value)].subject) ? '件名をコピーしました' : 'コピーできませんでした');
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
      <input type="checkbox" data-task="${t.id}" ${t.status === 'done' ? 'checked' : ''} ${applicable ? '' : 'disabled'} aria-label="${esc(t.title)}">
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

  document.getElementById('btn-add').addEventListener('click', () => {
    document.getElementById('form-add').reset();
    document.getElementById('add-error').textContent = '';
    syncAddFormType();
    dlgAdd.showModal();
  });
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  });

  // 雇用区分の選択肢を反映し、業務委託のとき社宅欄・ラベルを切り替える
  const typeSelect = document.querySelector('#form-add select[name="employmentType"]');
  typeSelect.innerHTML = TEMPLATES.employmentTypes
    .map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  typeSelect.addEventListener('change', syncAddFormType);

  function syncAddFormType() {
    const tpl = TEMPLATES.employmentTypes.find((t) => t.id === typeSelect.value) || TEMPLATES.employmentTypes[0];
    document.getElementById('add-housing-field').hidden = tpl.id !== 'fulltime';
    document.getElementById('add-joindate-label').textContent = tpl.joinDateLabel;
  }

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
  TEMPLATES = await api('/api/templates');
  setupDialogs();
  route();
})();
