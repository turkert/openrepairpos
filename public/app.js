/* OpenRepairPOS web app — plain JavaScript, no build step. Edit and reload. */
'use strict';

// ------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let S = {}; // settings
let ME = null;
const money = (n) => new Intl.NumberFormat(undefined, { style: 'currency', currency: S.currency || 'USD' }).format(Number(n) || 0);
const dt = (s) => (s ? new Date(s.includes('T') || s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const d = (s) => (s ? new Date(s.length === 10 ? s + 'T12:00' : s.replace(' ', 'T') + (s.includes('T') ? '' : 'Z')).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');
// Local calendar date (YYYY-MM-DD) in the browser's time zone, optionally offset by days.
const localDate = (d = new Date(), addDays = 0) => { const x = new Date(d); x.setDate(x.getDate() + addDays); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const today = () => localDate();
const isRole = (r) => ({ tech: 1, manager: 2, admin: 3 }[ME?.role] >= { tech: 1, manager: 2, admin: 3 }[r]);

async function api(method, url, body) {
  const r = await fetch('/api' + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !url.startsWith('/login') && !url.startsWith('/setup')) { ME = null; boot(); throw new Error('Signed out'); }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
const GET = (u) => api('GET', u);
const POST = (u, b = {}) => api('POST', u, b);
const PUT = (u, b = {}) => api('PUT', u, b);
const DEL = (u) => api('DELETE', u);

function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 5000 : 2200);
}
function form(el) {
  const o = {};
  for (const i of $$('[name]', el)) {
    if (i.type === 'checkbox') o[i.name] = i.checked;
    else if (i.type === 'number') o[i.name] = i.value === '' ? null : Number(i.value);
    else o[i.name] = i.value;
  }
  return o;
}
// Run an async action from a button/form with error toast.
const act = (fn) => async (e) => {
  e?.preventDefault?.();
  const b = e?.submitter || (e?.currentTarget?.tagName === 'BUTTON' ? e.currentTarget : null);
  if (b) b.disabled = true;
  try { await fn(e); } catch (err) { if (err.message !== 'Signed out') toast(err.message, true); } finally { if (b) b.disabled = false; }
};
function modal(html, { wide } = {}) {
  const m = $('#modal');
  m.innerHTML = `<div class="card ${wide ? 'wide' : ''}">${html}</div>`;
  m.hidden = false;
  m.onclick = (e) => { if (e.target === m) closeModal(); };
  $('[autofocus]', m)?.focus();
  return m.firstElementChild;
}
const closeModal = () => { $('#modal').hidden = true; $('#modal').innerHTML = ''; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  if (a.dataset.action === 'close-modal') closeModal();
  if (a.dataset.action === 'menu') $('#side')?.classList.toggle('open');
});
const field = (label, input) => `<div class="field"><label>${esc(label)}</label>${input}</div>`;
const inp = (name, value = '', attrs = '') => `<input name="${name}" value="${esc(value)}" ${attrs}>`;
const sel = (name, opts, value) => `<select name="${name}">${opts.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
const dur = (min) => { const m = Math.round(min || 0); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const repairTypeSel = (value = '') => sel('repair_type', [['', '— choose —'], ...(S.repair_types || []).map((x) => [x, x]), ...(value && !(S.repair_types || []).includes(value) ? [[value, value]] : [])], value);
const customInputs = (values = {}) => (S.ticket_custom_fields || []).map((k, i) => field(k, `<input data-custom="${esc(k)}" value="${esc(values[k] || '')}">`)).join('');
const readCustom = (root) => Object.fromEntries($$('[data-custom]', root).map((x) => [x.dataset.custom, x.value.trim()]).filter(([, v]) => v));
const PAY_METHODS = [['cash', 'Cash'], ['card', 'Card'], ['transfer', 'Bank transfer'], ['other', 'Other']];
function statusPill(s) {
  const map = { 'Ready for pickup': 'ok', Completed: 'ok', Cancelled: '', 'Waiting for parts': 'warn', 'Waiting for approval': 'warn', New: 'brand', paid: 'ok', partial: 'warn', unpaid: 'bad', void: '', draft: '', ordered: 'warn', received: 'ok' };
  return `<span class="pill ${map[s] ?? ''}">${esc(s)}</span>`;
}
function printHTML(html, cls = '') {
  let p = document.getElementById('print-area');
  if (!p) { p = document.createElement('div'); p.id = 'print-area'; document.body.appendChild(p); }
  p.className = cls; p.innerHTML = html;
  setTimeout(() => window.print(), 50);
}

// ------------------------------------------------------------------ boot & auth
async function boot() {
  const st = await fetch('/api/status').then((r) => r.json());
  if (st.setup_required) return renderSetup(st);
  try { ME = await fetch('/api/me').then((r) => (r.ok ? r.json() : null)); } catch { ME = null; }
  if (!ME) return renderLogin(st.store_name);
  S = await GET('/settings');
  route();
}
function renderSetup(st = {}) {
  $('#app').innerHTML = `<div class="auth"><form class="card" id="f">
    <h1>Welcome to OpenRepairPOS</h1><p class="muted">Create the owner account for your shop.</p>
    ${field('Shop name', inp('store_name', '', 'required autofocus'))}
    ${field('Your name', inp('name', '', 'required'))}
    ${field('Email', inp('email', '', 'type="email" required'))}
    ${field('Password (8+ characters)', inp('password', '', 'type="password" minlength="8" required'))}
    ${st.setup_code_required ? field('Setup code (from your installer)', inp('setup_code', '', 'required autocomplete="off"')) : ''}
    <label class="check" style="margin-bottom:14px"><input type="checkbox" name="sample_data"> Add sample tickets, parts and prices so I can try it out</label>
    <button class="btn primary" style="width:100%;justify-content:center">Create my shop</button>
    <p class="small muted" style="margin-bottom:0">Next: set your tax rate and store details in Settings. Everything else works right away.</p></form></div>`;
  $('#f').onsubmit = act(async (e) => { await POST('/setup', { ...form(e.target), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }); boot(); });
}
function renderLogin(name) {
  $('#app').innerHTML = `<div class="auth"><form class="card" id="f">
    <h1>${esc(name || 'OpenRepairPOS')}</h1><p class="muted">Sign in to continue.</p>
    ${field('Email', inp('email', '', 'type="email" required autofocus'))}
    ${field('Password', inp('password', '', 'type="password" required'))}
    <button class="btn primary">Sign in</button></form></div>`;
  $('#f').onsubmit = act(async (e) => { await POST('/login', form(e.target)); boot(); });
}

// ------------------------------------------------------------------ router & layout
const NAV = [
  ['#/', 'Dashboard', 'tech'], ['#/tickets', 'Tickets', 'tech'], ['#/pos', 'Point of Sale', 'tech'], ['#/customers', 'Customers', 'tech'],
  ['#/invoices', 'Invoices', 'tech'], ['#/appointments', 'Appointments', 'tech'], ['#/inventory', 'Inventory', 'tech'],
  ['#/prices', 'Repair Prices', 'tech'], ['#/purchase-orders', 'Purchase Orders', 'manager'], ['#/reports', 'Reports', 'manager'], ['#/settings', 'Settings', 'admin'],
];
const ROUTES = [
  [/^\/$/, pageDashboard], [/^\/tickets$/, pageTickets], [/^\/tickets\/new$/, pageNewTicket], [/^\/tickets\/(\d+)$/, pageTicket],
  [/^\/customers$/, pageCustomers], [/^\/customers\/(\d+)$/, pageCustomer], [/^\/inventory$/, pageInventory], [/^\/inventory\/(\d+)$/, pageItem],
  [/^\/prices$/, pagePrices], [/^\/pos$/, pagePOS], [/^\/invoices$/, pageInvoices], [/^\/invoices\/(\d+)$/, pageInvoice],
  [/^\/purchase-orders$/, pagePOs], [/^\/purchase-orders\/(\d+)$/, pagePO], [/^\/appointments$/, pageAppointments],
  [/^\/reports$/, pageReports], [/^\/settings(?:\/(\w+))?$/, pageSettings],
];
window.addEventListener('hashchange', () => ME && route());
function shell() {
  if ($('#main')) return $('#main');
  $('#app').innerHTML = `<div class="shell">
    <aside class="side" id="side"><div class="logo"><i></i>${esc(S.store_name)}</div>
      <nav>${NAV.filter((n) => isRole(n[2])).map(([h, l]) => `<a href="${h}">${l}</a>`).join('')}</nav>
      <div class="foot"><div><b>${esc(ME.name)}</b> · ${esc(ME.role)}</div>
        <div class="row" style="margin-top:6px"><button class="btn sm" id="clock">${ME.clocked_in ? 'Clock out' : 'Clock in'}</button><a href="#" id="logout">Sign out</a></div>
        <div style="margin-top:10px"><a href="https://openrepairpos.com" target="_blank" rel="noopener">OpenRepairPOS</a> · free & open source${S.p4c_enabled ? '<br>Parts by <a href="https://parts4cells.com" target="_blank" rel="noopener">Parts4Cells</a>' : ''}</div></div>
    </aside><main id="main"></main></div>`;
  drawTimerBadge();
  $('#logout').onclick = act(async () => { await POST('/logout'); ME = null; boot(); });
  $('#clock').onclick = act(async (e) => { const r = await POST('/clock/' + (ME.clocked_in ? 'out' : 'in')); ME.clocked_in = r.clocked_in; $('#clock').textContent = r.clocked_in ? 'Clock out' : 'Clock in'; toast(r.clocked_in ? 'Clocked in' : 'Clocked out'); });
  return $('#main');
}
function refreshLogo() { const l = $('.logo'); if (l) l.innerHTML = `<i></i>${esc(S.store_name)}`; document.title = `${S.store_name} · OpenRepairPOS`; }
function drawTimerBadge() {
  let b = $('#timer-badge');
  if (!b) { b = document.createElement('a'); b.id = 'timer-badge'; b.className = 'pill ok'; b.style.cssText = 'display:block;margin:10px 10px 0;text-align:center'; $('.side nav')?.after(b); }
  const r = ME.running_timer;
  b.hidden = !r;
  if (r) { b.href = '#/tickets/' + r.ticket_id; b.textContent = `⏱ Timer running · ${r.number}`; }
}
async function route() {
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  const need = [[/^\/settings/, 'admin'], [/^\/reports/, 'manager'], [/^\/purchase-orders/, 'manager']].find(([re]) => re.test(path))?.[1];
  const main = shell();
  $('#side').classList.remove('open');
  $$('.side nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + (path.match(/^\/[\w-]*/)?.[0] || '/')));
  if (need && !isRole(need)) { main.innerHTML = pageTop('No access') + `<div class="card empty">This page needs the ${need} role. Ask your shop owner if you need access.</div>`; return; }
  for (const [re, fn] of ROUTES) {
    const m = path.match(re);
    if (m) {
      main.innerHTML = '<div class="muted">Loading…</div>';
      try { await fn(main, ...m.slice(1)); } catch (e) { if (e.message !== 'Signed out') main.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
      return;
    }
  }
  main.innerHTML = '<div class="card empty">Page not found</div>';
}
const pageTop = (title, actions = '') => `<div class="top"><div class="row"><button class="btn sm menu-btn" data-action="menu" aria-label="Menu">☰</button><h1>${title}</h1></div><div class="actions">${actions}</div></div>`;

// ------------------------------------------------------------------ dashboard
async function pageDashboard(el) {
  const x = await GET('/dashboard');
  el.innerHTML = pageTop('Dashboard', `<a class="btn primary" href="#/tickets/new">+ New ticket</a><a class="btn" href="#/pos">New sale</a>`) + `
  <div class="grid g4">
    <div class="card stat"><div class="n">${x.open_tickets}</div><div class="l">Open tickets</div></div>
    <div class="card stat ${x.overdue ? 'alert' : ''}"><div class="n">${x.overdue}</div><div class="l">Overdue</div></div>
    <div class="card stat"><div class="n">${x.ready_for_pickup}</div><div class="l">Ready for pickup</div></div>
    <div class="card stat"><div class="n">${money(x.today_revenue)}</div><div class="l">Sales today</div></div>
  </div>
  <div class="split" style="margin-top:14px">
    <div class="card"><h2>Open repairs</h2>${ticketTable(x.recent)}<div style="margin-top:8px"><a href="#/tickets">All tickets →</a></div></div>
    <div class="grid">
      <div class="card"><h2>Today's appointments</h2>${x.today_appointments.length ? x.today_appointments.map((a) => `<div class="note"><b>${esc(a.starts_at.slice(11, 16))}</b> ${esc(a.title)}<div class="small muted">${esc(a.customer_name || '')} ${esc(a.customer_phone || '')}</div></div>`).join('') : '<div class="muted">None booked.</div>'}</div>
      <div class="card ${x.low_stock.length && S.p4c_enabled && isRole('manager') ? 'p4c' : ''}"><h2>Low stock (${x.low_stock.length})</h2>
        ${x.low_stock.slice(0, 6).map((i) => `<div class="row" style="justify-content:space-between"><span>${esc(i.name)}</span><span class="pill bad">${i.stock} left</span></div>`).join('') || '<div class="muted">All good.</div>'}
        ${x.low_stock.length && S.p4c_enabled && isRole('manager') ? `<div style="margin-top:10px"><a class="btn sm primary" href="#/purchase-orders">Reorder from Parts4Cells</a></div>` : ''}</div>
      <div class="card"><h2>By status</h2>${x.by_status.map((s) => `<div class="row" style="justify-content:space-between;margin:4px 0">${statusPill(s.status)}<b>${s.n}</b></div>`).join('') || '<div class="muted">No open tickets.</div>'}</div>
    </div>
  </div>`;
  bindRows(el);
}
function ticketTable(rows) {
  if (!rows.length) return '<div class="empty">No tickets.</div>';
  return `<div class="table-wrap"><table><tr><th>Ticket</th><th>Customer</th><th>Device</th><th>Status</th><th>Due</th><th>Tech</th></tr>
    ${rows.map((t) => `<tr class="click ${t.overdue ? 'overdue' : ''}" data-href="#/tickets/${t.id}"><td class="mono">${esc(t.number)}</td><td>${esc(t.customer_name)}<div class="small muted">${esc(t.customer_phone)}</div></td>
      <td>${esc([t.brand, t.model].join(' ').trim() || t.device_type)}<div class="small muted">${esc((t.issue || '').slice(0, 60))}</div></td><td>${statusPill(t.status)}</td>
      <td>${t.overdue ? `<span class="pill bad">${d(t.due_date)}</span>` : d(t.due_date)}</td><td>${esc(t.assigned_name || '')}</td></tr>`).join('')}</table></div>`;
}
const bindRows = (el) => $$('tr[data-href]', el).forEach((tr) => (tr.onclick = () => (location.hash = tr.dataset.href)));

// ------------------------------------------------------------------ tickets
async function pageTickets(el) {
  const view = localStorage.getItem('orp_ticket_view') || 'list';
  const users = await GET('/users');
  el.innerHTML = pageTop('Repair tickets', `<a class="btn primary" href="#/tickets/new">+ New ticket</a>`) + `
    <div class="card" style="margin-bottom:14px"><form class="row" id="flt">
      <input class="grow" name="q" placeholder="Search number, customer, phone, IMEI, device…" autofocus>
      ${sel('status', [['', 'All statuses'], ...S.ticket_statuses], '')}
      ${sel('assigned_to', [['', 'All techs'], ...users.map((u) => [u.id, u.name])], '')}
      <label class="check"><input type="checkbox" name="open" checked> Open only</label>
      <span class="row"><button type="button" class="btn sm ${view === 'list' ? 'primary' : ''}" data-v="list">List</button><button type="button" class="btn sm ${view === 'kanban' ? 'primary' : ''}" data-v="kanban">Board</button></span>
    </form></div><div id="res"></div>`;
  const load = async () => {
    const f = form($('#flt'));
    const qs = new URLSearchParams({ q: f.q, status: f.status, open: f.open ? '1' : '' });
    if (f.assigned_to) qs.set('assigned_to', f.assigned_to);
    const rows = await GET('/tickets?' + qs);
    const v = localStorage.getItem('orp_ticket_view') || 'list';
    $('#res').innerHTML = v === 'kanban' ? kanban(rows) : `<div class="card">${ticketTable(rows)}</div>`;
    bindRows(el);
    if (v === 'kanban') bindKanban(load);
  };
  let t; $('#flt').oninput = () => { clearTimeout(t); t = setTimeout(load, 200); };
  $('#flt').onsubmit = (e) => e.preventDefault();
  $$('[data-v]', el).forEach((b) => (b.onclick = () => { localStorage.setItem('orp_ticket_view', b.dataset.v); $$('[data-v]', el).forEach((x) => x.classList.toggle('primary', x === b)); load(); }));
  load();
}
function kanban(rows) {
  const statuses = S.ticket_statuses.filter((s) => !S.closed_statuses.includes(s) || rows.some((r) => r.status === s));
  return `<div class="kanban">${statuses.map((s) => { const list = rows.filter((r) => r.status === s); return `<div class="lane" data-status="${esc(s)}"><h3><span>${esc(s)}</span><span>${list.length}</span></h3>
    ${list.map((t) => `<div class="kcard ${t.overdue ? 'overdue' : ''}" draggable="true" data-id="${t.id}"><div class="row" style="justify-content:space-between"><a class="mono" href="#/tickets/${t.id}">${esc(t.number)}</a><span class="small muted">${d(t.due_date)}</span></div>
      <div><b>${esc([t.brand, t.model].join(' ').trim())}</b></div><div class="small muted">${esc(t.customer_name)} · ${esc((t.issue || '').slice(0, 40))}</div></div>`).join('')}</div>`; }).join('')}</div>`;
}
function bindKanban(reload) {
  $$('.kcard').forEach((c) => (c.ondragstart = (e) => e.dataTransfer.setData('text', c.dataset.id)));
  $$('.lane').forEach((l) => {
    l.ondragover = (e) => { e.preventDefault(); l.classList.add('drop'); };
    l.ondragleave = () => l.classList.remove('drop');
    l.ondrop = act(async (e) => { e.preventDefault(); l.classList.remove('drop'); await PUT('/tickets/' + e.dataTransfer.getData('text'), { status: l.dataset.status }); toast('Status updated'); reload(); });
  });
}

function customerPicker(container, onPick) {
  container.innerHTML = `<div class="row"><input class="grow" id="cq" placeholder="Search customer by name or phone…" autocomplete="off"><button type="button" class="btn" id="cnew">+ New customer</button></div><div id="cres"></div>`;
  let t;
  $('#cq', container).oninput = (e) => { clearTimeout(t); t = setTimeout(async () => {
    const q = e.target.value.trim(); if (!q) return ($('#cres', container).innerHTML = '');
    const rows = await GET('/customers?q=' + encodeURIComponent(q));
    $('#cres', container).innerHTML = rows.length ? `<table>${rows.slice(0, 8).map((c) => `<tr class="click" data-id="${c.id}"><td>${esc(c.first_name)} ${esc(c.last_name)}</td><td>${esc(c.phone)}</td><td class="muted">${esc(c.email)}</td></tr>`).join('')}</table>` : '<div class="muted small" style="padding:8px">No match — create a new customer.</div>';
    $$('tr[data-id]', container).forEach((tr) => (tr.onclick = () => onPick(rows.find((c) => c.id == tr.dataset.id))));
  }, 200); };
  $('#cnew', container).onclick = () => editCustomer(null, onPick, $('#cq', container).value);
}
function editCustomer(c, done, prefill = '') {
  const isPhone = /^[\d\s()+-]+$/.test(prefill);
  const m = modal(`<h2>${c ? 'Edit' : 'New'} customer</h2><form id="cf"><div class="grid g2">
    ${field('First name', inp('first_name', c?.first_name || (!isPhone ? prefill.split(' ')[0] : ''), 'required autofocus'))}${field('Last name', inp('last_name', c?.last_name || (!isPhone ? prefill.split(' ').slice(1).join(' ') : '')))}
    ${field('Phone', inp('phone', c?.phone || (isPhone ? prefill : ''), 'type="tel"'))}${field('Email', inp('email', c?.email, 'type="email"'))}
    ${field('Company', inp('company', c?.company))}${field('Address', inp('address', c?.address))}</div>
    ${field('Notes', `<textarea name="notes">${esc(c?.notes)}</textarea>`)}
    <div class="row"><button class="btn primary">Save</button><button type="button" class="btn" data-action="close-modal">Cancel</button></div></form>`);
  $('#cf', m).onsubmit = act(async (e) => { const r = c ? await PUT('/customers/' + c.id, form(e.target)) : await POST('/customers', form(e.target)); closeModal(); done(r); });
}

async function pageNewTicket(el) {
  const [users, prices] = await Promise.all([GET('/users'), GET('/prices')]);
  let customer = null;
  const pre = new URLSearchParams(location.hash.split('?')[1] || '');
  if (pre.get('customer')) customer = await GET('/customers/' + pre.get('customer'));
  el.innerHTML = pageTop('New repair ticket') + `<form id="tf"><div class="split"><div class="grid">
    <div class="card"><h2>Customer</h2><div id="cust"></div></div>
    <div class="card"><h2>Device</h2><div class="grid g3">
      ${field('Type', sel('device_type', ['Phone', 'Tablet', 'Laptop', 'Desktop', 'Watch', 'Console', 'Other'], 'Phone'))}
      ${field('Brand', inp('brand', '', 'list="brands" placeholder="Apple"'))}${field('Model', inp('model', '', 'placeholder="iPhone 13"'))}
      ${field('IMEI / Serial', inp('serial'))}${field('Passcode / pattern', inp('passcode'))}${field('Priority', sel('priority', ['low', 'normal', 'high', 'urgent'], 'normal'))}</div>
      <datalist id="brands">${['Apple', 'Samsung', 'Google', 'Motorola', 'OnePlus', 'LG', 'Huawei', 'Xiaomi', 'Dell', 'HP', 'Lenovo'].map((b) => `<option value="${b}">`).join('')}</datalist>
      ${(S.ticket_custom_fields || []).length ? `<div class="grid g3">${customInputs()}</div>` : ''}
      ${field('Problem described by customer', '<textarea name="issue" required></textarea>')}
      ${prices.length ? field('Quick pick from price list', `<select id="pp"><option value="">—</option>${prices.map((p) => `<option value="${p.id}">${esc(p.brand)} ${esc(p.model)} – ${esc(p.repair)} (${money(p.price)})</option>`).join('')}</select>`) : ''}
    </div>
    <div class="card"><h2>Pre-repair checklist</h2><div class="checks">${S.checklist.map((c, i) => `<label class="check"><input type="checkbox" name="chk_${i}"> ${esc(c)}</label>`).join('')}</div></div>
  </div><div class="grid">
    <div class="card"><h2>Job</h2>
      ${field('Repair type', repairTypeSel())}
      ${field('Estimate', inp('estimate', '', 'type="number" step="0.01" min="0"'))}
      <div class="grid g2">${field('Deposit taken', inp('deposit', '', 'type="number" step="0.01" min="0" placeholder="0.00"'))}${field('Paid by', sel('deposit_method', PAY_METHODS, 'cash'))}</div>
      ${field('Due date', inp('due_date', localDate(new Date(), 1), 'type="date"'))}
      ${field('Assign to', sel('assigned_to', [['', 'Unassigned'], ...users.filter((u) => u.active).map((u) => [u.id, u.name])], ''))}
      ${field('Warranty (days)', inp('warranty_days', S.default_warranty_days, 'type="number" min="0"'))}
      <button class="btn primary" style="width:100%;justify-content:center">Create ticket</button>
    </div></div></div></form>`;
  const showCustomer = (c) => {
    customer = c;
    $('#cust').innerHTML = `<div class="row" style="justify-content:space-between"><div><b>${esc(c.first_name)} ${esc(c.last_name)}</b><div class="muted small">${esc(c.phone)} ${esc(c.email)}</div></div><button type="button" class="btn sm" id="chg">Change</button></div>`;
    $('#chg').onclick = () => customerPicker($('#cust'), showCustomer);
  };
  customer ? showCustomer(customer) : customerPicker($('#cust'), showCustomer);
  if ($('#pp')) $('#pp').onchange = (e) => {
    const p = prices.find((x) => x.id == e.target.value);
    if (!p) { const f = $('#tf'); delete f.dataset.price; delete f.dataset.priceItem; delete f.dataset.priceDesc; return; }
    const f = $('#tf'); f.brand.value = p.brand; f.model.value = p.model; f.estimate.value = p.price; f.warranty_days.value = p.warranty_days;
    const rt = (S.repair_types || []).find((x) => x.toLowerCase() === p.repair.toLowerCase()) || (S.repair_types || []).find((x) => p.repair.toLowerCase().includes(x.toLowerCase().split(' ')[0]));
    if (rt) f.repair_type.value = rt;
    if (!f.issue.value) f.issue.value = p.repair; f.dataset.priceItem = p.item_id || ''; f.dataset.priceDesc = `${p.repair} – ${p.brand} ${p.model}`; f.dataset.price = p.price;
  };
  $('#tf').onsubmit = act(async (e) => {
    if (!customer) throw new Error('Pick or create a customer first');
    const f = form(e.target);
    const pre_checklist = {}; S.checklist.forEach((c, i) => (pre_checklist[c] = !!f['chk_' + i]));
    const items = e.target.dataset.price ? [{ description: e.target.dataset.priceDesc, unit_price: Number(e.target.dataset.price), kind: 'labor' }] : [];
    // If the price-list entry is linked to a part, reserve it; the repair price covers part + labor.
    if (e.target.dataset.priceItem) items[0] = { item_id: Number(e.target.dataset.priceItem), description: e.target.dataset.priceDesc, unit_price: Number(e.target.dataset.price) };
    const t = await POST('/tickets', { customer_id: customer.id, device_type: f.device_type, brand: f.brand, model: f.model, serial: f.serial, passcode: f.passcode, priority: f.priority, issue: f.issue, estimate: f.estimate || 0, due_date: f.due_date, assigned_to: f.assigned_to ? Number(f.assigned_to) : null, warranty_days: f.warranty_days, pre_checklist, items, repair_type: f.repair_type, custom: readCustom(e.target), deposit: f.deposit ? { amount: f.deposit, method: f.deposit_method } : null });
    toast('Ticket ' + t.number + ' created');
    location.hash = '#/tickets/' + t.id;
  });
}

async function pageTicket(el, id) {
  const [t, users] = await Promise.all([GET('/tickets/' + id), GET('/users')]);
  const trackUrl = `${S.public_url ? S.public_url.replace(/\/$/, '') : location.origin}/track/${t.tracking_code}`;
  const chk = (obj) => Object.keys(obj).length ? Object.entries(obj).map(([k, v]) => `<span class="pill ${v ? 'ok' : 'bad'}">${v ? '✓' : '✗'} ${esc(k)}</span>`).join(' ') : '<span class="muted">Not recorded</span>';
  el.innerHTML = pageTop(`Ticket <span class="mono">${esc(t.number)}</span> ${statusPill(t.status)}`, `
      <button class="btn" id="plabel">Print label</button><button class="btn" id="preceipt">Print receipt</button>
      ${t.invoice_id ? `<a class="btn primary" href="#/invoices/${t.invoice_id}">View invoice</a>` : `<button class="btn primary" id="inv">Create invoice</button>`}`) + `
  <div class="split"><div class="grid">
    <div class="card"><div class="row" style="justify-content:space-between;align-items:flex-start"><div>
      <h2>${esc([t.brand, t.model].join(' ').trim() || t.device_type)}</h2><div class="muted">${esc(t.device_type)} · IMEI/Serial <span class="mono">${esc(t.serial || '—')}</span>${t.passcode ? ` · Passcode <span class="mono">${esc(t.passcode)}</span>` : ''}</div>
      <p>${esc(t.issue)}</p>
      ${t.repair_type ? `<span class="pill brand">${esc(t.repair_type)}</span> ` : ''}${Object.entries(t.custom || {}).map(([k, v]) => `<span class="pill">${esc(k)}: ${esc(v)}</span>`).join(' ')}</div><button class="btn sm" id="edit">Edit</button></div>
      <h3>Pre-repair check</h3><div>${chk(t.pre_checklist)}</div>
      <h3 style="margin-top:10px">Post-repair check</h3><div>${chk(t.post_checklist)} <button class="btn sm" id="post">Record</button></div>
    </div>
    <div class="card"><div class="row" style="justify-content:space-between"><h2>Parts & labor</h2><div class="row"><button class="btn sm" id="addpart">+ Part</button><button class="btn sm" id="addlabor">+ Labor</button></div></div>
      ${t.items.length ? `<table><tr><th>Description</th><th class="right">Qty</th><th class="right">Price</th><th></th></tr>${t.items.map((i) => `<tr><td>${esc(i.description)} <span class="pill">${esc(i.kind)}</span></td><td class="right">${i.qty}</td><td class="right">${money(i.qty * i.unit_price)}</td><td class="right">${t.invoice_id ? '' : `<button class="btn sm danger" data-rm="${i.id}">✕</button>`}</td></tr>`).join('')}
        <tr><td colspan="2"><b>Total (before tax)</b></td><td class="right"><b>${money(t.items_total)}</b></td><td></td></tr></table>` : `<div class="muted">No parts or labor yet. Estimate: ${money(t.estimate)}</div>`}
    </div>
    <div class="card"><h2>Notes</h2><form id="nf"><textarea name="body" placeholder="Add a note…" required></textarea>
      <div class="row" style="margin-top:6px">${sel('type', [['internal', 'Internal (staff only)'], ['diagnostic', 'Diagnostic (customer can see)']], 'internal')}<button class="btn primary">Add note</button></div></form>
      <div class="notes" style="margin-top:10px">${t.notes.map((n) => `<div class="note ${n.type === 'system' ? 'system' : ''}"><div class="meta">${dt(n.created_at)} · ${esc(n.user_name || 'System')} ${n.type === 'diagnostic' ? '<span class="pill brand">customer-visible</span>' : n.type === 'internal' ? '<span class="pill">internal</span>' : ''}</div>${esc(n.body)}</div>`).join('')}</div>
    </div>
  </div><div class="grid">
    <div class="card"><h2>Status</h2>${field('Status', sel('status', S.ticket_statuses, t.status))}
      ${field('Assigned to', sel('assigned_to', [['', 'Unassigned'], ...users.map((u) => [u.id, u.name])], t.assigned_to || ''))}
      ${field('Due date', inp('due_date', t.due_date || '', 'type="date"'))}
      <div class="small muted">Customers are notified on: ${esc(S.notify_statuses.join(', '))}</div></div>
    <div class="card"><div class="row" style="justify-content:space-between"><h2>Time on this job</h2><b>${dur(t.minutes_total)}</b></div>
      ${(() => { const mine = t.time.find((x) => !x.stopped_at && x.user_id === ME.id); return mine ? `<button class="btn danger" id="tstop" style="width:100%;justify-content:center">■ Stop timer (started ${new Date(mine.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})</button>` : `<button class="btn primary" id="tstart" style="width:100%;justify-content:center">▶ Start timer</button>`; })()}
      <div class="small" style="margin-top:8px">${t.time.slice(0, 6).map((x) => `<div class="row" style="justify-content:space-between"><span>${esc(x.user_name)} · ${d(x.started_at)}</span><span>${x.stopped_at ? dur(x.minutes) : '<span class="pill ok">running</span>'}</span></div>`).join('')}</div>
      <button class="btn sm" id="tadd" style="margin-top:6px">+ Add time manually</button></div>
    <div class="card"><div class="row" style="justify-content:space-between"><h2>Deposits</h2><b>${money(t.deposits.reduce((a, x) => a + x.amount, 0))}</b></div>
      ${t.deposits.length ? t.deposits.map((x) => `<div class="row small" style="justify-content:space-between"><span>${d(x.created_at)} · ${esc(x.method)}${x.reference ? ' · ' + esc(x.reference) : ''}</span><span>${money(x.amount)} ${x.invoice_id ? '<span class="pill ok">applied</span>' : isRole('manager') ? `<button class="btn sm danger" data-dep="${x.id}">✕</button>` : ''}</span></div>`).join('') : '<div class="muted small">No deposit taken.</div>'}
      ${t.invoice_id ? '' : '<button class="btn sm" id="dadd" style="margin-top:8px">+ Take deposit</button>'}
      <div class="small muted" style="margin-top:6px">Deposits are applied automatically when you create the invoice.</div></div>
    <div class="card"><h2>Customer</h2><a href="#/customers/${t.customer_id}"><b>${esc(t.customer_name)}</b></a><div class="muted">${esc(t.customer_phone)}<br>${esc(t.customer_email)}</div>
      <div class="hr"></div><h3>Tracking link</h3><div class="code">${esc(trackUrl)}</div><div class="row" style="margin-top:6px"><button class="btn sm" id="copy">Copy</button><a class="btn sm" target="_blank" href="${esc(trackUrl)}">Open</a></div></div>
    <div class="card"><h2>Terms & signature</h2>${t.signature ? `<img class="sig-img" src="${esc(t.signature)}" alt="signature"><div class="small muted">Accepted ${dt(t.terms_accepted_at)}</div>` : `<p class="small muted">${esc(S.terms)}</p><button class="btn" id="sign">Collect signature</button>`}</div>
    <div class="card small muted">Created ${dt(t.created_at)}<br>Updated ${dt(t.updated_at)}<br>Warranty ${esc(t.warranty_days)} days</div>
  </div></div>`;
  const reload = () => pageTicket(el, id);
  const upd = (patch) => act(async () => { await PUT('/tickets/' + t.id, patch()); toast('Saved'); reload(); });
  $('[name=status]', el).onchange = (e) => upd(() => ({ status: e.target.value }))();
  $('[name=assigned_to]', el).onchange = (e) => upd(() => ({ assigned_to: e.target.value ? Number(e.target.value) : null }))();
  $('[name=due_date]', el).onchange = (e) => upd(() => ({ due_date: e.target.value }))();
  $('#nf').onsubmit = act(async (e) => { await POST(`/tickets/${t.id}/notes`, form(e.target)); reload(); });
  $('#copy').onclick = () => navigator.clipboard.writeText(trackUrl).then(() => toast('Copied'));
  $$('[data-rm]', el).forEach((b) => (b.onclick = act(async () => { await DEL(`/tickets/${t.id}/items/${b.dataset.rm}`); reload(); })));
  if ($('#inv')) $('#inv').onclick = act(async () => { const inv = await POST(`/tickets/${t.id}/invoice`); toast('Invoice ' + inv.number); location.hash = '#/invoices/' + inv.id; });
  $('#addpart').onclick = () => pickItem(async (item, qty) => { await POST(`/tickets/${t.id}/items`, { item_id: item.id, qty }); reload(); });
  $('#addlabor').onclick = () => {
    const m = modal(`<h2>Add labor</h2><form id="lf">${field('Description', inp('description', 'Labor', 'required autofocus'))}${field('Price', inp('unit_price', '', 'type="number" step="0.01" required'))}<button class="btn primary">Add</button></form>`);
    $('#lf', m).onsubmit = act(async (e) => { await POST(`/tickets/${t.id}/items`, { ...form(e.target), kind: 'labor' }); closeModal(); reload(); });
  };
  $('#post').onclick = () => {
    const m = modal(`<h2>Post-repair check</h2><form id="pf"><div class="checks">${S.checklist.map((c, i) => `<label class="check"><input type="checkbox" name="c${i}" ${t.post_checklist[c] ? 'checked' : ''}> ${esc(c)}</label>`).join('')}</div><div style="margin-top:12px"><button class="btn primary">Save</button></div></form>`);
    $('#pf', m).onsubmit = act(async (e) => { const f = form(e.target); const post_checklist = {}; S.checklist.forEach((c, i) => (post_checklist[c] = f['c' + i])); await PUT('/tickets/' + t.id, { post_checklist }); closeModal(); reload(); });
  };
  $('#edit').onclick = () => {
    const m = modal(`<h2>Edit device</h2><form id="ef"><div class="grid g2">${field('Brand', inp('brand', t.brand))}${field('Model', inp('model', t.model))}${field('IMEI / Serial', inp('serial', t.serial))}${field('Passcode', inp('passcode', t.passcode))}${field('Estimate', inp('estimate', t.estimate, 'type="number" step="0.01"'))}${field('Priority', sel('priority', ['low', 'normal', 'high', 'urgent'], t.priority))}${field('Repair type', repairTypeSel(t.repair_type))}${customInputs(t.custom)}</div>${field('Issue', `<textarea name="issue">${esc(t.issue)}</textarea>`)}<button class="btn primary">Save</button></form>`);
    $('#ef', m).onsubmit = act(async (e) => { const f = form(e.target); await PUT('/tickets/' + t.id, { ...f, custom: { ...(t.custom || {}), ...readCustom(e.target) } }); closeModal(); reload(); });
  };
  if ($('#tstart')) $('#tstart').onclick = act(async () => { await POST(`/tickets/${t.id}/timer/start`); ME.running_timer = { ticket_id: t.id, number: t.number }; drawTimerBadge(); reload(); });
  if ($('#tstop')) $('#tstop').onclick = act(async () => { await POST(`/tickets/${t.id}/timer/stop`); ME.running_timer = null; drawTimerBadge(); reload(); });
  $('#tadd').onclick = () => {
    const m = modal(`<h2>Add time</h2><form id="tf2">${field('Minutes', inp('minutes', '', 'type="number" min="1" required autofocus'))}${field('Technician', sel('user_id', users.filter((u) => u.active).map((u) => [u.id, u.name]), ME.id))}<button class="btn primary">Add</button></form>`);
    $('#tf2', m).onsubmit = act(async (e) => { const f = form(e.target); await POST(`/tickets/${t.id}/time`, { minutes: f.minutes, user_id: Number(f.user_id) }); closeModal(); reload(); });
  };
  if ($('#dadd')) $('#dadd').onclick = () => {
    const m = modal(`<h2>Take deposit</h2><form id="df">${field('Amount', inp('amount', '', 'type="number" step="0.01" min="0.01" required autofocus'))}${field('Method', sel('method', PAY_METHODS, 'cash'))}${field('Reference (optional)', inp('reference'))}<button class="btn primary">Record deposit</button></form>`);
    $('#df', m).onsubmit = act(async (e) => { await POST(`/tickets/${t.id}/deposits`, form(e.target)); closeModal(); toast('Deposit recorded'); reload(); });
  };
  $$('[data-dep]', el).forEach((b) => (b.onclick = act(async () => { if (!confirm('Remove this deposit? Only do this if you refunded it.')) return; await DEL(`/tickets/${t.id}/deposits/${b.dataset.dep}`); reload(); })));
  if ($('#sign')) $('#sign').onclick = () => signaturePad(async (dataUrl) => { await PUT('/tickets/' + t.id, { signature: dataUrl }); reload(); });
  $('#plabel').onclick = () => printHTML(`<div style="font-family:monospace;padding:4mm"><div style="font-size:20px;font-weight:700">${esc(t.number)}</div><div>${esc(t.customer_name)} ${esc(t.customer_phone)}</div><div>${esc(t.brand)} ${esc(t.model)}</div><div>${esc((t.issue || '').slice(0, 60))}</div><div>Due ${d(t.due_date)}</div>${t.passcode ? `<div>PW: ${esc(t.passcode)}</div>` : ''}</div>`, 'label');
  $('#preceipt').onclick = () => printHTML(`<div class="doc">${docHead('Repair receipt', t.number, t.created_at)}
    <p><b>Customer:</b> ${esc(t.customer_name)} · ${esc(t.customer_phone)}<br><b>Device:</b> ${esc(t.brand)} ${esc(t.model)} · ${esc(t.serial)}<br><b>Problem:</b> ${esc(t.issue)}<br><b>Estimate:</b> ${money(t.estimate)} · <b>Due:</b> ${d(t.due_date)}${t.deposit_total ? ` · <b>Deposit paid:</b> ${money(t.deposit_total)}` : ''}${Object.entries(t.custom || {}).map(([k, v]) => `<br><b>${esc(k)}:</b> ${esc(v)}`).join('')}</p>
    <p><b>Track your repair:</b> ${esc(trackUrl)}</p><p style="font-size:11px">${esc(S.terms)}</p>
    ${t.signature ? `<img src="${esc(t.signature)}" style="max-width:220px">` : '<p>Signature: ______________________</p>'}</div>`);
}
function docHead(title, number, date) {
  return `<div class="head"><div><div style="font-size:18px;font-weight:700">${esc(S.store_name)}</div><div>${esc(S.store_address)}</div><div>${esc(S.store_phone)} ${esc(S.store_email)}</div></div>
    <div style="text-align:right"><div style="font-size:18px;font-weight:700">${esc(title)}</div><div>${esc(number)}</div><div>${dt(date)}</div></div></div>`;
}
function signaturePad(onSave) {
  const m = modal(`<h2>Customer signature</h2><p class="small muted">${esc(S.terms)}</p><canvas class="sig" width="600" height="200"></canvas>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="ok">I agree & sign</button><button class="btn" id="clr">Clear</button><button class="btn" data-action="close-modal">Cancel</button></div>`);
  const c = $('canvas', m); const ctx = c.getContext('2d'); let drawing = false; let drawn = false;
  ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
  const pos = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height)]; };
  c.onpointerdown = (e) => { drawing = true; c.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); };
  c.onpointermove = (e) => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); drawn = true; };
  c.onpointerup = () => (drawing = false);
  $('#clr', m).onclick = () => { ctx.clearRect(0, 0, c.width, c.height); drawn = false; };
  $('#ok', m).onclick = act(async () => { if (!drawn) throw new Error('Please sign first'); await onSave(c.toDataURL('image/png')); closeModal(); toast('Signature saved'); });
}
function pickItem(onPick, { services = true } = {}) {
  const m = modal(`<h2>Add item</h2><div class="row"><input class="grow" id="iq" placeholder="Search parts by name, SKU, barcode…" autofocus><input id="qty" type="number" value="1" min="1" style="width:80px"></div><div id="ir" style="margin-top:8px"></div>`, { wide: true });
  const load = async () => {
    const rows = (await GET('/items?q=' + encodeURIComponent($('#iq', m).value))).filter((i) => services || i.kind !== 'service');
    $('#ir', m).innerHTML = `<table>${rows.slice(0, 30).map((i) => `<tr class="click" data-id="${i.id}"><td>${esc(i.name)}<div class="small muted mono">${esc(i.sku)}</div></td><td>${esc(i.kind)}</td><td class="right">${i.kind === 'service' ? '' : `${i.stock} in stock`}</td><td class="right">${money(i.price)}</td></tr>`).join('')}</table>`;
    $$('tr[data-id]', m).forEach((tr) => (tr.onclick = act(async () => { await onPick(rows.find((i) => i.id == tr.dataset.id), Number($('#qty', m).value) || 1); closeModal(); })));
  };
  let t; $('#iq', m).oninput = () => { clearTimeout(t); t = setTimeout(load, 150); }; load();
}

// ------------------------------------------------------------------ customers
async function pageCustomers(el) {
  el.innerHTML = pageTop('Customers', `<button class="btn primary" id="new">+ New customer</button>`) + `<div class="card"><input id="q" placeholder="Search name, phone, email, company…" autofocus><div id="res" style="margin-top:10px"></div></div>`;
  const load = async () => {
    const rows = await GET('/customers?q=' + encodeURIComponent($('#q').value));
    $('#res').innerHTML = rows.length ? `<div class="table-wrap"><table><tr><th>Name</th><th>Phone</th><th>Email</th><th>Company</th><th class="right">Tickets</th></tr>${rows.map((c) => `<tr class="click" data-href="#/customers/${c.id}"><td>${esc(c.first_name)} ${esc(c.last_name)}</td><td>${esc(c.phone)}</td><td>${esc(c.email)}</td><td>${esc(c.company)}</td><td class="right">${c.ticket_count}</td></tr>`).join('')}</table></div>` : '<div class="empty">No customers yet.</div>';
    bindRows(el);
  };
  let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(load, 200); };
  $('#new').onclick = () => editCustomer(null, (c) => (location.hash = '#/customers/' + c.id));
  load();
}
async function pageCustomer(el, id) {
  const c = await GET('/customers/' + id);
  el.innerHTML = pageTop(`${esc(c.first_name)} ${esc(c.last_name)}`, `<button class="btn" id="edit">Edit</button>${isRole('manager') ? '<button class="btn" id="credit">Store credit</button>' : ''}<a class="btn primary" href="#/tickets/new?customer=${c.id}">+ New ticket</a>`) + `
  <div class="split"><div class="grid">
    <div class="card"><h2>Tickets</h2>${c.tickets.length ? `<table>${c.tickets.map((t) => `<tr class="click" data-href="#/tickets/${t.id}"><td class="mono">${esc(t.number)}</td><td>${esc(t.brand)} ${esc(t.model)}<div class="small muted">${esc(t.issue)}</div></td><td>${statusPill(t.status)}</td><td>${d(t.created_at)}</td></tr>`).join('')}</table>` : '<div class="muted">None</div>'}</div>
    <div class="card"><h2>Invoices</h2>${c.invoices.length ? `<table>${c.invoices.map((i) => `<tr class="click" data-href="#/invoices/${i.id}"><td class="mono">${esc(i.number)}</td><td>${statusPill(i.status)}</td><td class="right">${money(i.total)}</td><td>${d(i.created_at)}</td></tr>`).join('')}</table>` : '<div class="muted">None</div>'}</div>
  </div><div class="card"><h2>Contact</h2><div>${esc(c.phone)}</div><div>${esc(c.email)}</div><div>${esc(c.company)}</div><div>${esc(c.address)}</div>
    <div class="hr"></div><h3>Store credit</h3><div class="stat"><div class="n">${money(c.store_credit)}</div></div>
    ${c.notes ? `<div class="hr"></div><h3>Notes</h3><div>${esc(c.notes)}</div>` : ''}<div class="small muted" style="margin-top:10px">Customer since ${d(c.created_at)}</div></div></div>`;
  bindRows(el);
  $('#edit').onclick = () => editCustomer(c, () => pageCustomer(el, id));
  if ($('#credit')) $('#credit').onclick = () => {
    const m = modal(`<h2>Adjust store credit</h2><form id="sf">${field('Amount (negative to deduct)', inp('amount', '', 'type="number" step="0.01" required autofocus'))}${field('Reason', inp('reason'))}<button class="btn primary">Save</button></form>`);
    $('#sf', m).onsubmit = act(async (e) => { await POST(`/customers/${c.id}/store-credit`, form(e.target)); closeModal(); pageCustomer(el, id); });
  };
}

// ------------------------------------------------------------------ inventory
async function pageInventory(el) {
  el.innerHTML = pageTop('Inventory', `${isRole('manager') ? '<button class="btn" id="imp">Import CSV</button><button class="btn" id="count">Stock count</button><button class="btn primary" id="new">+ New item</button>' : ''}`) + `
    <div class="card"><div class="row"><input class="grow" id="q" placeholder="Search name, SKU, barcode (scanners work here)…" autofocus>${sel('kind', [['', 'All types'], ['part', 'Parts'], ['product', 'Products'], ['service', 'Services']], '')}<label class="check"><input type="checkbox" id="low"> Low stock only</label></div><div id="res" style="margin-top:10px"></div></div>`;
  const load = async () => {
    const qs = new URLSearchParams({ q: $('#q').value, kind: $('[name=kind]', el).value, low: $('#low').checked ? '1' : '' });
    const rows = await GET('/items?' + qs);
    $('#res').innerHTML = rows.length ? `<div class="table-wrap"><table><tr><th>Item</th><th>Category</th><th>Supplier</th><th class="right">Cost</th><th class="right">Price</th><th class="right">Stock</th></tr>
      ${rows.map((i) => `<tr class="click" data-href="#/inventory/${i.id}"><td>${esc(i.name)}<div class="small muted mono">${esc(i.sku)}</div></td><td>${esc(i.category)}</td><td>${esc(i.supplier)}</td><td class="right">${money(i.cost)}</td><td class="right">${money(i.price)}</td>
      <td class="right">${i.kind === 'service' ? '—' : `<span class="pill ${i.stock <= i.min_stock ? 'bad' : 'ok'}">${i.stock}</span>`}</td></tr>`).join('')}</table></div>` : '<div class="empty">No items.</div>';
    bindRows(el);
  };
  let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(load, 150); };
  $('[name=kind]', el).onchange = load; $('#low').onchange = load;
  if ($('#new')) {
    $('#new').onclick = () => editItem(null, (i) => (location.hash = '#/inventory/' + i.id));
    $('#imp').onclick = importItems(load);
    $('#count').onclick = stockCount;
  }
  load();
}
function editItem(i, done) {
  const m = modal(`<h2>${i ? 'Edit' : 'New'} item</h2><form id="itf"><div class="grid g2">
    ${field('Name', inp('name', i?.name, 'required autofocus'))}${field('Type', sel('kind', [['part', 'Part'], ['product', 'Retail product'], ['service', 'Service / labor']], i?.kind || 'part'))}
    ${field('SKU (blank = auto)', inp('sku', i?.sku))}${field('Barcode', inp('barcode', i?.barcode))}
    ${field('Category', inp('category', i?.category))}${field('Supplier', inp('supplier', i?.supplier ?? (S.p4c_enabled ? 'Parts4Cells' : ''), 'list="sup"'))}
    ${field('Supplier SKU', inp('supplier_sku', i?.supplier_sku))}${field('Low-stock level', inp('min_stock', i?.min_stock ?? 2, 'type="number" step="1"'))}
    ${field('Cost', inp('cost', i?.cost ?? '', 'type="number" step="0.01"'))}${field('Price', inp('price', i?.price ?? '', 'type="number" step="0.01"'))}
    ${i ? '' : field('Opening stock', inp('stock', 0, 'type="number"'))}<div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" name="taxable" ${i?.taxable === 0 ? '' : 'checked'}> Taxable</label></div>
    </div><datalist id="sup">${S.p4c_enabled ? '<option value="Parts4Cells">' : ''}</datalist><button class="btn primary">Save</button></form>`);
  $('#itf', m).onsubmit = act(async (e) => { const f = form(e.target); const r = i ? await PUT('/items/' + i.id, f) : await POST('/items', f); closeModal(); done(r); });
}
const importItems = (reload) => () => {
  const m = modal(`<h2>Import items from CSV</h2><p class="small muted">Columns (header row required): name, sku, category, kind, cost, price, stock, min_stock, supplier, supplier_sku, barcode</p><input type="file" id="file" accept=".csv,text/csv"><div id="prev" class="small muted" style="margin:8px 0"></div><button class="btn primary" id="go" disabled>Import</button>`);
  let items = [];
  $('#file', m).onchange = async (e) => {
    const text = await e.target.files[0].text();
    const rows = parseCSV(text); const head = rows.shift().map((h) => h.trim().toLowerCase());
    items = rows.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
    $('#prev', m).textContent = `${items.length} items ready to import.`; $('#go', m).disabled = !items.length;
  };
  $('#go', m).onclick = act(async () => { const r = await POST('/items/import', { items }); closeModal(); toast(`Imported ${r.length} items`); reload(); });
};
function parseCSV(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
async function stockCount() {
  const items = (await GET('/items')).filter((i) => i.kind !== 'service');
  const m = modal(`<h2>Stock count</h2><p class="small muted">Enter what you physically counted. Only changed rows are adjusted.</p><form id="scf"><table>${items.map((i) => `<tr><td>${esc(i.name)}<div class="small muted">${esc(i.sku)}</div></td><td class="right muted">${i.stock}</td><td style="width:100px"><input type="number" data-id="${i.id}" data-was="${i.stock}" value="${i.stock}"></td></tr>`).join('')}</table><div style="margin-top:10px"><button class="btn primary">Save count</button></div></form>`, { wide: true });
  $('#scf', m).onsubmit = act(async (e) => {
    const counts = $$('input[data-id]', m).filter((x) => x.value !== x.dataset.was).map((x) => ({ item_id: Number(x.dataset.id), counted: Number(x.value) }));
    if (counts.length) await POST('/stock-count', { counts });
    closeModal(); toast(`${counts.length} items adjusted`); route();
  });
}
async function pageItem(el, id) {
  const i = await GET('/items/' + id);
  const p4c = S.p4c_enabled && i.kind !== 'service' ? (S.p4c_search_url || '').replace('{query}', encodeURIComponent(i.supplier_sku || i.name)) : '';
  el.innerHTML = pageTop(esc(i.name), `${p4c ? `<a class="btn" target="_blank" rel="noopener" href="${esc(p4c)}">Find on Parts4Cells ↗</a>` : ''}${isRole('manager') ? `<button class="btn" id="adj">Adjust stock</button><button class="btn" id="ser">Add serials</button><button class="btn" id="edit">Edit</button><button class="btn danger" id="del">Archive</button>` : ''}`) + `
  <div class="grid g4"><div class="card stat"><div class="n">${i.kind === 'service' ? '—' : i.stock}</div><div class="l">In stock (alert at ${i.min_stock})</div></div>
    <div class="card stat"><div class="n">${money(i.price)}</div><div class="l">Price</div></div><div class="card stat"><div class="n">${money(i.cost)}</div><div class="l">Cost</div></div>
    <div class="card stat"><div class="n">${i.price ? Math.round(((i.price - i.cost) / i.price) * 100) : 0}%</div><div class="l">Margin</div></div></div>
  <div class="grid g2" style="margin-top:14px"><div class="card"><h2>Stock history</h2>${i.moves.length ? `<table>${i.moves.map((m) => `<tr><td>${dt(m.created_at)}</td><td>${esc(m.reason)} <span class="muted mono">${esc(m.ref)}</span></td><td class="right"><b>${m.qty > 0 ? '+' : ''}${esc(m.qty)}</b></td></tr>`).join('')}</table>` : '<div class="muted">No movements.</div>'}</div>
  <div class="card"><h2>Details</h2><table><tr><td class="muted">SKU</td><td class="mono">${esc(i.sku)}</td></tr><tr><td class="muted">Barcode</td><td class="mono">${esc(i.barcode)}</td></tr><tr><td class="muted">Category</td><td>${esc(i.category)}</td></tr><tr><td class="muted">Supplier</td><td>${esc(i.supplier)} <span class="mono">${esc(i.supplier_sku)}</span></td></tr><tr><td class="muted">Taxable</td><td>${i.taxable ? 'Yes' : 'No'}</td></tr></table>
    ${i.serials.length ? `<h3 style="margin-top:12px">Serials / IMEIs</h3>${i.serials.map((s) => `<span class="pill mono">${esc(s.serial)}</span>`).join(' ')}` : ''}</div></div>`;
  if (!$('#edit')) return;
  $('#edit').onclick = () => editItem(i, () => pageItem(el, id));
  $('#del').onclick = act(async () => { if (!confirm('Archive this item?')) return; await DEL('/items/' + id); location.hash = '#/inventory'; });
  $('#adj').onclick = () => {
    const m = modal(`<h2>Adjust stock</h2><form id="af">${field('Quantity (+ add / − remove)', inp('qty', '', 'type="number" required autofocus'))}${field('Reason', sel('reason', ['Received', 'Damaged', 'Returned to supplier (RMA)', 'Lost', 'Correction'], 'Received'))}${field('Reference', inp('ref'))}<button class="btn primary">Save</button></form>`);
    $('#af', m).onsubmit = act(async (e) => { await POST(`/items/${id}/adjust`, form(e.target)); closeModal(); pageItem(el, id); });
  };
  $('#ser').onclick = () => {
    const m = modal(`<h2>Add serial numbers / IMEIs</h2><form id="sf"><textarea name="s" placeholder="One per line" autofocus></textarea><button class="btn primary">Add</button></form>`);
    $('#sf', m).onsubmit = act(async (e) => { await POST(`/items/${id}/serials`, { serials: e.target.s.value.split('\n') }); closeModal(); pageItem(el, id); });
  };
}

// ------------------------------------------------------------------ repair price list
async function pagePrices(el) {
  const rows = await GET('/prices');
  el.innerHTML = pageTop('Repair price list', isRole('manager') ? '<button class="btn primary" id="new">+ Add price</button>' : '') + `
    <div class="card"><p class="muted small" style="margin-top:0">Used for quick quotes at check-in and by AI assistants connected over MCP.</p><input id="q" placeholder="Filter…"><div id="res" style="margin-top:10px"></div></div>`;
  const draw = () => {
    const q = $('#q').value.toLowerCase();
    const list = rows.filter((p) => `${p.brand} ${p.model} ${p.repair}`.toLowerCase().includes(q));
    $('#res').innerHTML = list.length ? `<table><tr><th>Device</th><th>Repair</th><th>Linked part</th><th class="right">Price</th><th></th></tr>${list.map((p) => `<tr><td>${esc(p.brand)} ${esc(p.model)}</td><td>${esc(p.repair)}</td><td>${esc(p.part_name || '')}${p.part_name ? ` <span class="pill ${p.part_stock > 0 ? 'ok' : 'bad'}">${p.part_stock}</span>` : ''}</td><td class="right">${money(p.price)}</td><td class="right">${isRole('manager') ? `<button class="btn sm" data-e="${p.id}">Edit</button> <button class="btn sm danger" data-d="${p.id}">✕</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">No prices yet.</div>';
    $$('[data-e]', el).forEach((b) => (b.onclick = () => editPrice(rows.find((p) => p.id == b.dataset.e))));
    $$('[data-d]', el).forEach((b) => (b.onclick = act(async () => { await DEL('/prices/' + b.dataset.d); pagePrices(el); })));
  };
  const editPrice = async (p) => {
    const items = (await GET('/items?kind=part'));
    const m = modal(`<h2>${p ? 'Edit' : 'Add'} repair price</h2><form id="pf"><div class="grid g2">${field('Brand', inp('brand', p?.brand, 'required autofocus'))}${field('Model', inp('model', p?.model, 'required'))}${field('Repair', inp('repair', p?.repair, 'required placeholder="Screen replacement"'))}${field('Price', inp('price', p?.price, 'type="number" step="0.01" required'))}${field('Minutes', inp('minutes', p?.minutes ?? 60, 'type="number"'))}${field('Warranty days', inp('warranty_days', p?.warranty_days ?? S.default_warranty_days, 'type="number"'))}</div>${field('Linked part (reserved at check-in)', sel('item_id', [['', '— none —'], ...items.map((i) => [i.id, i.name])], p?.item_id || ''))}<button class="btn primary">Save</button></form>`);
    $('#pf', m).onsubmit = act(async (e) => { const f = form(e.target); p ? await PUT('/prices/' + p.id, f) : await POST('/prices', f); closeModal(); pagePrices(el); });
  };
  $('#q').oninput = draw; if ($('#new')) $('#new').onclick = () => editPrice(null); draw();
}

// ------------------------------------------------------------------ point of sale
async function pagePOS(el) {
  const cart = []; let customer = null; let discount = 0;
  const items = await GET('/items');
  el.innerHTML = pageTop('Point of sale') + `<div class="pos"><div class="card">
      <input id="q" placeholder="Scan barcode or search products…" autofocus><div class="tiles" id="tiles" style="margin-top:10px"></div></div>
    <div class="card"><h2>Sale</h2><div id="cust"></div><div class="hr"></div><div id="cart"></div></div></div>`;
  const tiles = () => {
    const q = $('#q').value.toLowerCase();
    const list = items.filter((i) => !q || `${i.name} ${i.sku} ${i.barcode} ${i.category}`.toLowerCase().includes(q)).slice(0, 60);
    $('#tiles').innerHTML = list.map((i) => `<button class="tile" data-id="${i.id}"><b>${esc(i.name)}</b><span class="muted small">${money(i.price)}${i.kind !== 'service' ? ` · ${i.stock} left` : ''}</span></button>`).join('') || '<div class="muted">No match</div>';
    $$('.tile', el).forEach((b) => (b.onclick = () => add(items.find((i) => i.id == b.dataset.id))));
  };
  const add = (i) => { const l = cart.find((x) => x.item_id === i.id); l ? l.qty++ : cart.push({ item_id: i.id, description: i.name, qty: 1, unit_price: i.price, taxable: i.taxable }); draw(); };
  const totals = () => {
    const sub = cart.reduce((a, l) => a + l.qty * l.unit_price, 0);
    const taxBase = cart.reduce((a, l) => a + (l.taxable ? l.qty * l.unit_price : 0), 0);
    const disc = Math.min(discount, sub); const tax = Math.max(0, taxBase - (sub ? disc * taxBase / sub : 0)) * (S.tax_rate / 100);
    return { sub, disc, tax: Math.round(tax * 100) / 100, total: Math.round((sub - disc + tax) * 100) / 100 };
  };
  const drawTotals = () => {
    const t = totals();
    const box = $('#tot'); if (!box) return;
    box.innerHTML = `<tr><td>Subtotal</td><td class="right">${money(t.sub)}</td></tr><tr><td>Discount</td><td class="right">−${money(t.disc)}</td></tr><tr><td>Tax (${esc(S.tax_rate)}%)</td><td class="right">${money(t.tax)}</td></tr><tr class="grand"><td>Total</td><td class="right">${money(t.total)}</td></tr>`;
  };
  // Inputs update the cart and totals on every keystroke without rebuilding the buttons,
  // so a click on Cash/Card right after typing is never lost.
  const draw = () => {
    $('#cart').innerHTML = cart.length ? `<table>${cart.map((l, i) => `<tr><td>${esc(l.description)}</td><td style="width:70px"><input type="number" min="1" step="1" value="${esc(l.qty)}" data-q="${i}" aria-label="Quantity"></td><td style="width:96px"><input type="number" min="0" step="0.01" value="${esc(l.unit_price)}" data-p="${i}" aria-label="Price"></td><td><button class="btn sm danger" data-x="${i}" aria-label="Remove">✕</button></td></tr>`).join('')}</table>
      <div class="row" style="margin-top:8px"><label for="disc" style="margin:0">Discount</label><input type="number" min="0" step="0.01" id="disc" value="${discount || ''}" style="width:110px"></div>
      <table class="totals" id="tot" style="margin-top:8px"></table>
      <div class="row" style="margin-top:10px">${['cash', 'card', 'transfer'].map((mth) => `<button class="btn primary" data-pay="${mth}">${mth[0].toUpperCase() + mth.slice(1)}</button>`).join('')}<button class="btn" data-pay="">Save unpaid</button><button class="btn danger" id="clear">Clear</button></div>`
      : '<div class="muted">Cart is empty. Tap a product or scan a barcode.</div>';
    drawTotals();
    $$('[data-q]', el).forEach((x) => (x.oninput = () => { cart[x.dataset.q].qty = Math.max(0, Number(x.value) || 0); drawTotals(); }));
    $$('[data-p]', el).forEach((x) => (x.oninput = () => { cart[x.dataset.p].unit_price = Math.max(0, Number(x.value) || 0); drawTotals(); }));
    $$('[data-x]', el).forEach((x) => (x.onclick = () => { cart.splice(Number(x.dataset.x), 1); draw(); }));
    if ($('#disc')) $('#disc').oninput = (e) => { discount = Math.max(0, Number(e.target.value) || 0); drawTotals(); };
    if ($('#clear')) $('#clear').onclick = () => { cart.length = 0; discount = 0; draw(); };
    $$('[data-pay]', el).forEach((b) => (b.onclick = act(async () => {
      const lines = cart.filter((l) => l.qty > 0);
      if (!lines.length) throw new Error('Cart is empty');
      const method = b.dataset.pay; let reference = '';
      const total = totals().total;
      if (method === 'cash') { const given = prompt(`Total ${money(total)} — cash received?`, total.toFixed(2)); if (given === null) return; if (Number(given) < total) throw new Error('Cash received is less than the total — use "Save unpaid" and take a partial payment on the invoice.'); const ch = Number(given) - total; if (ch > 0.004) alert(`Change due: ${money(ch)}`); }
      if (method === 'card') { const ref = prompt('Card reference / last 4 (optional)'); if (ref === null) return; reference = ref; }
      const inv = await POST('/invoices', { customer_id: customer?.id || null, lines, discount, payments: method ? [{ method, reference }] : [] });
      toast('Sale ' + inv.number + ' saved'); location.hash = '#/invoices/' + inv.id;
    })));
  };
  const showCust = (c) => { customer = c; $('#cust').innerHTML = c ? `<div class="row" style="justify-content:space-between"><span><b>${esc(c.first_name)} ${esc(c.last_name)}</b> <span class="muted">${esc(c.phone)}</span></span><button class="btn sm" id="rmc">✕</button></div>` : '<button class="btn sm" id="addc">+ Attach customer</button>';
    if ($('#rmc')) $('#rmc').onclick = () => showCust(null);
    if ($('#addc')) $('#addc').onclick = () => { const m = modal('<h2>Customer</h2><div id="pk"></div>'); customerPicker($('#pk', m), (c2) => { closeModal(); showCust(c2); }); };
  };
  $('#q').oninput = tiles;
  $('#q').onkeydown = (e) => { if (e.key === 'Enter') { const code = e.target.value.trim(); const hit = items.find((i) => i.barcode === code || i.sku === code); if (hit) { add(hit); e.target.value = ''; tiles(); } } };
  showCust(null); tiles(); draw();
}

// ------------------------------------------------------------------ invoices
async function pageInvoices(el) {
  el.innerHTML = pageTop('Invoices', '<a class="btn primary" href="#/pos">New sale</a>') + `<div class="card"><div class="row"><input class="grow" id="q" placeholder="Search number or customer…">${sel('status', [['', 'All'], 'unpaid', 'partial', 'paid', 'void'], '')}<input type="date" id="from"><input type="date" id="to"></div><div id="res" style="margin-top:10px"></div></div>`;
  const load = async () => {
    const qs = new URLSearchParams({ q: $('#q').value, status: $('[name=status]', el).value, from: $('#from').value, to: $('#to').value });
    const rows = await GET('/invoices?' + qs);
    $('#res').innerHTML = rows.length ? `<div class="table-wrap"><table><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Status</th><th class="right">Total</th><th class="right">Balance</th></tr>${rows.map((i) => `<tr class="click" data-href="#/invoices/${i.id}"><td class="mono">${esc(i.number)}</td><td>${esc(i.customer_name || 'Walk-in')}</td><td>${dt(i.created_at)}</td><td>${statusPill(i.status)}</td><td class="right">${money(i.total)}</td><td class="right">${i.status === 'void' ? '—' : money(i.total - i.paid)}</td></tr>`).join('')}</table></div>` : '<div class="empty">No invoices.</div>';
    bindRows(el);
  };
  let t; $$('input,select', el).forEach((x) => (x.oninput = () => { clearTimeout(t); t = setTimeout(load, 200); })); load();
}
async function pageInvoice(el, id) {
  const i = await GET('/invoices/' + id);
  const doc = () => `<div class="doc">${docHead(i.status === 'paid' ? 'Receipt' : 'Invoice', i.number, i.created_at)}
    <p><b>Bill to:</b> ${esc(i.customer_name || 'Walk-in customer')}<br>${esc(i.customer_phone || '')} ${esc(i.customer_email || '')}${i.ticket_number ? `<br><b>Repair ticket:</b> ${esc(i.ticket_number)} · Warranty ${esc(i.warranty_days)} days` : ''}</p>
    <table><tr><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Amount</th></tr>${i.lines.map((l) => `<tr><td>${esc(l.description)}</td><td style="text-align:right">${l.qty}</td><td style="text-align:right">${money(l.unit_price)}</td><td style="text-align:right">${money(l.qty * l.unit_price)}</td></tr>`).join('')}</table>
    <table class="totals" style="width:280px;margin-left:auto;margin-top:8px"><tr><td>Subtotal</td><td class="right">${money(i.subtotal)}</td></tr>${i.discount ? `<tr><td>Discount</td><td class="right">−${money(i.discount)}</td></tr>` : ''}<tr><td>Tax</td><td class="right">${money(i.tax)}</td></tr><tr class="grand"><td>Total</td><td class="right">${money(i.total)}</td></tr><tr><td>Paid</td><td class="right">${money(i.paid)}</td></tr><tr><td><b>Balance</b></td><td class="right"><b>${money(i.balance)}</b></td></tr>${i.overpaid ? `<tr><td colspan="2" class="small">Deposit exceeded the total by ${money(i.overpaid)} — added to the customer's store credit.</td></tr>` : ''}</table>
    ${i.payments.length ? `<p class="small">Payments: ${i.payments.map((p) => `${esc(p.method)} ${money(p.amount)} (${dt(p.created_at)})`).join('; ')}</p>` : ''}<p class="small">${esc(S.terms)}</p></div>`;
  el.innerHTML = pageTop(`Invoice <span class="mono">${esc(i.number)}</span> ${statusPill(i.status)}`, `<button class="btn" id="printdoc">Print</button>${i.balance > 0 && i.status !== 'void' ? '<button class="btn primary" id="pay">Take payment</button>' : ''}${isRole('manager') && i.status !== 'void' ? '<button class="btn danger" id="void">Void</button>' : ''}`) + `<div class="card">${doc()}</div>`;
  $('#printdoc').onclick = () => printHTML(doc());
  if ($('#void')) $('#void').onclick = act(async () => { if (!confirm('Void this invoice? Stock from retail lines is returned.')) return; await POST(`/invoices/${i.id}/void`); pageInvoice(el, id); });
  if ($('#pay')) $('#pay').onclick = () => {
    const m = modal(`<h2>Take payment</h2><form id="pf">${field('Amount', inp('amount', i.balance, 'type="number" step="0.01" required autofocus'))}${field('Method', sel('method', [['cash', 'Cash'], ['card', 'Card'], ['transfer', 'Bank transfer'], ['store_credit', 'Store credit'], ['other', 'Other']], 'cash'))}${field('Reference', inp('reference'))}<button class="btn primary">Record payment</button></form>`);
    $('#pf', m).onsubmit = act(async (e) => { await POST(`/invoices/${i.id}/payments`, form(e.target)); closeModal(); toast('Payment recorded'); pageInvoice(el, id); });
  };
}

// ------------------------------------------------------------------ purchase orders + Parts4Cells
async function pagePOs(el) {
  const [pos, reorder] = await Promise.all([GET('/purchase-orders'), GET('/parts-order-list')]);
  el.innerHTML = pageTop('Purchase orders', '<button class="btn primary" id="new">+ New PO</button>') + `
  ${reorder.length || S.p4c_enabled ? `<div class="card ${S.p4c_enabled ? 'p4c' : ''}" style="margin-bottom:14px"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">${S.p4c_enabled ? 'Reorder from Parts4Cells' : 'Reorder low-stock parts'}</h2><div class="small muted">${reorder.length} item${reorder.length === 1 ? '' : 's'} at or below the low-stock level.${S.p4c_enabled ? ' Wholesale phone parts, shipped from Houston, TX.' : ''}</div></div>
    ${reorder.length ? '<div class="row"><button class="btn" id="csv">Download order list</button><button class="btn primary" id="mkpo">Create PO for all</button></div>' : ''}</div>
    ${reorder.length ? `<table style="margin-top:10px"><tr><th>Item</th><th class="right">Stock</th><th class="right">Suggested qty</th><th></th></tr>${reorder.map((r) => `<tr><td>${esc(r.name)}<div class="small muted mono">${esc(r.supplier_sku || r.sku)}</div></td><td class="right">${r.stock} / ${r.min_stock}</td><td class="right"><b>${r.suggested_qty}</b></td><td class="right">${r.parts4cells_url ? `<a class="btn sm" target="_blank" rel="noopener" href="${esc(r.parts4cells_url)}">Find on Parts4Cells ↗</a>` : esc(r.supplier || '')}</td></tr>`).join('')}</table>` : ''}</div>` : ''}
  <div class="card">${pos.length ? `<table><tr><th>PO</th><th>Supplier</th><th>Status</th><th>Created</th><th class="right">Lines</th><th class="right">Total</th></tr>${pos.map((p) => `<tr class="click" data-href="#/purchase-orders/${p.id}"><td class="mono">${esc(p.number)}</td><td>${esc(p.supplier)}</td><td>${statusPill(p.status)}</td><td>${d(p.created_at)}</td><td class="right">${p.line_count}</td><td class="right">${money(p.total)}</td></tr>`).join('')}</table>` : '<div class="empty">No purchase orders yet.</div>'}</div>`;
  bindRows(el);
  if ($('#csv')) $('#csv').onclick = () => {
    const csv = [`name,sku,supplier_sku,in_stock,order_qty${S.p4c_enabled ? ',parts4cells_link' : ''}`, ...reorder.map((r) => [r.name, r.sku, r.supplier_sku, r.stock, r.suggested_qty, ...(S.p4c_enabled ? [r.parts4cells_url] : [])].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${S.p4c_enabled ? 'parts4cells-' : ''}order-${today()}.csv`; a.click();
  };
  if ($('#mkpo')) $('#mkpo').onclick = act(async () => { const po = await POST('/purchase-orders', { supplier: S.p4c_enabled ? 'Parts4Cells' : '', lines: reorder.map((r) => ({ item_id: r.item_id, qty: r.suggested_qty })) }); location.hash = '#/purchase-orders/' + po.id; });
  $('#new').onclick = async () => {
    const lines = [];
    const all = (await GET('/items')).filter((i) => i.kind !== 'service');
    const m = modal(`<h2>New purchase order</h2>${field('Supplier', inp('supplier', S.p4c_enabled ? 'Parts4Cells' : '', 'id="sup" list="sup2" placeholder="Supplier name"'))}<datalist id="sup2">${S.p4c_enabled ? '<option value="Parts4Cells">' : ''}</datalist>
      <div class="row"><input class="grow" id="iq" placeholder="Search parts to add…"></div><div id="ir"></div><div class="hr"></div><div id="ls"></div>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="save">Create PO</button></div>`, { wide: true });
    const draw = () => {
      $('#ls', m).innerHTML = lines.length ? `<table>${lines.map((l, i) => `<tr><td>${esc(l.name)}</td><td style="width:80px"><input type="number" min="1" value="${l.qty}" data-q="${i}"></td><td style="width:100px"><input type="number" step="0.01" value="${l.unit_cost}" data-c="${i}"></td><td><button class="btn sm danger" data-r="${i}">✕</button></td></tr>`).join('')}</table>` : '<div class="muted small">No items yet.</div>';
      $$('[data-q]', m).forEach((x) => (x.onchange = () => (lines[x.dataset.q].qty = Number(x.value))));
      $$('[data-c]', m).forEach((x) => (x.onchange = () => (lines[x.dataset.c].unit_cost = Number(x.value))));
      $$('[data-r]', m).forEach((x) => (x.onclick = () => { lines.splice(x.dataset.r, 1); draw(); }));
    };
    $('#iq', m).oninput = (e) => {
      const q = e.target.value.toLowerCase();
      const hits = q ? all.filter((i) => `${i.name} ${i.sku} ${i.supplier_sku}`.toLowerCase().includes(q)).slice(0, 8) : [];
      $('#ir', m).innerHTML = hits.map((i) => `<div class="row" style="justify-content:space-between;padding:4px 0"><span>${esc(i.name)} <span class="muted small">${i.stock} in stock</span></span><button class="btn sm" data-a="${i.id}">Add</button></div>`).join('');
      $$('[data-a]', m).forEach((b) => (b.onclick = () => { const i = all.find((x) => x.id == b.dataset.a); lines.push({ item_id: i.id, name: i.name, qty: Math.max(1, i.min_stock * 2 - i.stock), unit_cost: i.cost }); draw(); }));
    };
    $('#save', m).onclick = act(async () => { if (!lines.length) throw new Error('Add at least one item'); const po = await POST('/purchase-orders', { supplier: $('#sup', m).value, lines }); closeModal(); location.hash = '#/purchase-orders/' + po.id; });
    draw();
  };
}
async function pagePO(el, id) {
  const p = await GET('/purchase-orders/' + id);
  el.innerHTML = pageTop(`PO <span class="mono">${esc(p.number)}</span> ${statusPill(p.status)}`, `${p.status === 'draft' ? '<button class="btn" id="ord">Mark ordered</button>' : ''}${['draft', 'ordered', 'partial'].includes(p.status) ? '<button class="btn primary" id="rcv">Receive</button>' : ''}<button class="btn" id="printdoc">Print</button>`) + `
    <div class="card"><div class="muted">Supplier: <b>${esc(p.supplier)}</b> · Created ${d(p.created_at)}</div>
    <table style="margin-top:10px"><tr><th>Item</th><th>Supplier SKU</th><th class="right">Ordered</th><th class="right">Received</th><th class="right">Unit cost</th><th class="right">Amount</th></tr>${p.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="mono">${esc(l.supplier_sku)}</td><td class="right">${l.qty}</td><td class="right">${l.received_qty}</td><td class="right">${money(l.unit_cost)}</td><td class="right">${money(l.qty * l.unit_cost)}</td></tr>`).join('')}
    <tr><td colspan="5"><b>Total</b></td><td class="right"><b>${money(p.total)}</b></td></tr></table></div>`;
  if ($('#ord')) $('#ord').onclick = act(async () => { await POST(`/purchase-orders/${id}/status`, { status: 'ordered' }); pagePO(el, id); });
  if ($('#rcv')) $('#rcv').onclick = () => {
    const m = modal(`<h2>Receive items</h2><form id="rf"><table>${p.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="muted right">${l.received_qty}/${l.qty}</td><td style="width:90px"><input type="number" data-l="${l.id}" value="${l.qty - l.received_qty}" min="0"></td></tr>`).join('')}</table><div style="margin-top:10px"><button class="btn primary">Receive into stock</button></div></form>`);
    $('#rf', m).onsubmit = act(async () => { await POST(`/purchase-orders/${id}/receive`, { lines: $$('[data-l]', m).map((x) => ({ line_id: Number(x.dataset.l), qty: Number(x.value) })).filter((x) => x.qty) }); closeModal(); toast('Stock updated'); pagePO(el, id); });
  };
  $('#printdoc').onclick = () => printHTML(`<div class="doc">${docHead('Purchase order', p.number, p.created_at)}<p><b>Supplier:</b> ${esc(p.supplier)}</p><table><tr><th>Item</th><th>Supplier SKU</th><th>Qty</th><th>Unit</th></tr>${p.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.supplier_sku)}</td><td>${l.qty}</td><td>${money(l.unit_cost)}</td></tr>`).join('')}</table><p><b>Total ${money(p.total)}</b></p></div>`);
}

// ------------------------------------------------------------------ appointments
async function pageAppointments(el) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const from = localDate(start);
  const to = localDate(start, 13);
  const rows = await GET(`/appointments?from=${from}&to=${to}`);
  const days = [...Array(14)].map((_, i) => localDate(start, i));
  el.innerHTML = pageTop('Appointments', '<button class="btn primary" id="new">+ Book appointment</button>') + `<div class="grid g2">${days.map((day) => { const list = rows.filter((a) => a.starts_at.slice(0, 10) === day); return `<div class="card"><h3>${new Date(day + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</h3>${list.map((a) => `<div class="note row" style="justify-content:space-between;${a.status === 'done' ? 'opacity:.55' : ''}"><div>${a.status === 'done' ? '<span class="pill ok">done</span> ' : ''}<b>${esc(a.starts_at.slice(11, 16))}</b> ${esc(a.title)} ${a.source === 'ai' ? '<span class="pill brand">AI</span>' : ''}<div class="small muted">${esc(a.customer_name || '')} ${esc(a.customer_phone || '')} ${esc(a.notes)}</div></div><div class="row">${a.status === 'done' ? '' : `<button class="btn sm" data-done="${a.id}">Done</button>`}<button class="btn sm danger" data-cx="${a.id}">✕</button></div></div>`).join('') || '<div class="muted small">—</div>'}</div>`; }).join('')}</div>`;
  $$('[data-done]', el).forEach((b) => (b.onclick = act(async () => { await PUT('/appointments/' + b.dataset.done, { status: 'done' }); toast('Marked done'); pageAppointments(el); })));
  $$('[data-cx]', el).forEach((b) => (b.onclick = act(async () => { await PUT('/appointments/' + b.dataset.cx, { status: 'cancelled' }); pageAppointments(el); })));
  $('#new').onclick = () => {
    const m = modal(`<h2>Book appointment</h2><form id="af"><div class="grid g2">${field('Date', inp('date', from, 'type="date" required'))}${field('Time', inp('time', '10:00', 'type="time" required'))}${field('Customer name', inp('name', '', 'required autofocus'))}${field('Phone', inp('phone', '', 'type="tel"'))}${field('Minutes', inp('minutes', 30, 'type="number"'))}${field('What for', inp('title', '', 'required placeholder="iPhone 13 screen"'))}</div>${field('Notes', '<textarea name="notes"></textarea>')}<button class="btn primary">Book</button></form>`);
    $('#af', m).onsubmit = act(async (e) => { const f = form(e.target); await POST('/appointments', { ...f, starts_at: `${f.date}T${f.time}` }); closeModal(); pageAppointments(el); });
  };
}

// ------------------------------------------------------------------ reports
async function pageReports(el) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const r = await GET('/reports?' + q);
  const max = Math.max(1, ...r.daily.map((x) => x.revenue));
  el.innerHTML = pageTop('Reports', `<form class="row" id="rf"><input type="date" name="from" value="${esc(r.from)}"><input type="date" name="to" value="${esc(r.to)}"><button class="btn">Apply</button><button type="button" class="btn" id="csv">Export CSV</button></form>`) + `
  <div class="grid g4"><div class="card stat"><div class="n">${money(r.sales.revenue)}</div><div class="l">Revenue (incl. tax)</div></div><div class="card stat"><div class="n">${money(r.sales.gross_profit)}</div><div class="l">Gross profit</div></div>
    <div class="card stat"><div class="n">${r.tickets_closed}<span class="muted" style="font-size:14px"> / ${r.tickets_created}</span></div><div class="l">Tickets closed / created</div></div><div class="card stat"><div class="n">${money(r.inventory_value)}</div><div class="l">Inventory value (cost)</div></div></div>
  <div class="grid g2" style="margin-top:14px">
    <div class="card"><h2>Daily sales</h2>${r.daily.map((x) => `<div class="row small" style="margin:3px 0"><span style="width:84px">${d(x.day)}</span><div class="grow"><div class="bar" style="width:${(x.revenue / max) * 100}%"></div></div><span style="width:80px" class="right">${money(x.revenue)}</span></div>`).join('') || '<div class="muted">No sales in range.</div>'}</div>
    <div class="card"><h2>Payments by method</h2><table>${r.payments_by_method.map((p) => `<tr><td>${esc(p.method)}</td><td class="right">${money(p.amount)}</td></tr>`).join('') || '<tr><td class="muted">None</td></tr>'}</table>
      <h2 style="margin-top:14px">Summary</h2><table><tr><td>Invoices</td><td class="right">${r.sales.invoices}</td></tr><tr><td>Tax collected</td><td class="right">${money(r.sales.tax)}</td></tr><tr><td>Cost of goods</td><td class="right">${money(r.sales.cogs)}</td></tr><tr><td>Outstanding balances</td><td class="right">${money(r.sales.outstanding)}</td></tr></table></div>
    <div class="card"><h2>Top devices repaired</h2><table>${r.top_repairs.map((x) => `<tr><td>${esc(x.device)}</td><td class="right">${x.n}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</table></div>
    <div class="card"><h2>Top sellers</h2><table>${r.top_items.map((x) => `<tr><td>${esc(x.description)}</td><td class="right">${x.qty}</td><td class="right">${money(x.revenue)}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</table></div>
    <div class="card"><h2>Open tickets by status</h2><table>${r.tickets_by_status.filter((x) => !S.closed_statuses.includes(x.status)).map((x) => `<tr><td>${statusPill(x.status)}</td><td class="right">${x.n}</td></tr>`).join('')}</table>
      ${r.deposits_held ? `<p class="small muted" style="margin-bottom:0">Deposits held on open tickets: <b>${money(r.deposits_held)}</b></p>` : ''}</div>
  </div>
  <div class="card" style="margin-top:14px"><h2>Profit by repair type</h2>${r.by_repair_type.length ? `<div class="table-wrap"><table><tr><th>Repair type</th><th class="right">Jobs</th><th class="right">Revenue</th><th class="right">Parts cost</th><th class="right">Profit</th><th class="right">Per job</th><th class="right">Margin</th></tr>
    ${r.by_repair_type.map((x) => `<tr><td>${esc(x.repair_type)}</td><td class="right">${x.jobs}</td><td class="right">${money(x.revenue)}</td><td class="right">${money(x.cost)}</td><td class="right"><b>${money(x.profit)}</b></td><td class="right">${money(x.profit_per_job)}</td><td class="right">${x.margin_pct}%</td></tr>`).join('')}</table></div>` : '<div class="muted">No invoiced repairs in this range. Set a repair type on tickets to see this breakdown.</div>'}
    <p class="small muted" style="margin-bottom:0">Revenue is before tax and after discounts, from invoiced repair tickets.</p></div>
  <div class="card" style="margin-top:14px"><h2>Technicians</h2>${r.by_technician.length ? `<div class="table-wrap"><table><tr><th>Technician</th><th class="right">Closed</th><th class="right">Hours logged</th><th class="right">Revenue</th><th class="right">Profit</th><th class="right">Revenue / hour</th><th class="right">Commission</th></tr>
    ${r.by_technician.map((x) => `<tr><td>${esc(x.tech)}</td><td class="right">${x.closed}</td><td class="right">${x.hours}</td><td class="right">${money(x.revenue)}</td><td class="right">${money(x.profit)}</td><td class="right">${x.hours ? money(x.revenue / x.hours) : '—'}</td><td class="right">${x.commission_rate ? `<b>${money(x.commission)}</b> <span class="small muted">(${x.commission_rate}% of ${esc(x.commission_basis)})</span>` : '<span class="muted small">no rate set</span>'}</td></tr>`).join('')}</table></div>` : '<div class="muted">—</div>'}
    <p class="small muted" style="margin-bottom:0">Set commission rates in Settings → Users, and choose profit or revenue as the basis in Settings → Tickets.</p></div>`;
  $('#rf').onsubmit = (e) => { e.preventDefault(); location.hash = '#/reports?' + new URLSearchParams(form(e.target)); };
  $('#csv').onclick = () => { const q2 = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`; const csv = ['day,invoices,revenue', ...r.daily.map((x) => `${x.day},${x.invoices},${Number(x.revenue).toFixed(2)}`), '', 'repair_type,jobs,revenue,parts_cost,profit,margin_pct', ...r.by_repair_type.map((x) => [x.repair_type, x.jobs, x.revenue, x.cost, x.profit, x.margin_pct].map(q2).join(',')), '', 'technician,closed,hours,revenue,profit,commission', ...r.by_technician.map((x) => [x.tech, x.closed, x.hours, x.revenue, x.profit, x.commission].map(q2).join(','))].join('\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `sales-${r.from}-${r.to}.csv`; a.click(); };
}

// ------------------------------------------------------------------ settings
async function pageSettings(el, tab = 'store') {
  const tabs = [['store', 'Store'], ['tickets', 'Tickets'], ['users', 'Users'], ['ai', 'AI & API'], ['integrations', 'Webhooks'], ['parts', 'Parts4Cells']];
  el.innerHTML = pageTop('Settings') + `<div class="tabs">${tabs.map(([k, l]) => `<a href="#/settings/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</div><div id="tab"></div>`;
  const t = $('#tab');
  const saveForm = (f, fields) => act(async (e) => { const v = form(e.target); const patch = {}; for (const k of fields) patch[k] = v[k]; S = await PUT('/settings', patch); refreshLogo(); toast('Saved'); });
  if (tab === 'store') {
    t.innerHTML = `<form class="card" id="sf"><div class="grid g2">${field('Store name', inp('store_name', S.store_name))}${field('Phone', inp('store_phone', S.store_phone))}${field('Email', inp('store_email', S.store_email))}${field('Address', inp('store_address', S.store_address))}${field('Hours', inp('store_hours', S.store_hours))}${field('Currency (ISO code)', inp('currency', S.currency))}${field('Sales tax %', inp('tax_rate', S.tax_rate, 'type="number" step="0.001" min="0"'))}${field('Time zone (for reports and “today”)', inp('timezone', S.timezone, 'list="tzs" placeholder="America/Chicago"') + `<datalist id="tzs">${(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []).map((z) => `<option value="${z}">`).join('')}</datalist>`)}${field('Public URL (for tracking links)', inp('public_url', S.public_url, 'placeholder="https://repairs.myshop.com"'))}</div>
      ${field('Terms & conditions (shown at signature and on receipts)', `<textarea name="terms">${esc(S.terms)}</textarea>`)}<button class="btn primary">Save</button></form>`;
    $('#sf').onsubmit = saveForm($('#sf'), ['store_name', 'store_phone', 'store_email', 'store_address', 'store_hours', 'currency', 'tax_rate', 'timezone', 'public_url', 'terms']);
  }
  if (tab === 'tickets') {
    t.innerHTML = `<form class="card" id="sf"><div class="grid g2">${field('Ticket prefix', inp('ticket_prefix', S.ticket_prefix))}${field('Invoice prefix', inp('invoice_prefix', S.invoice_prefix))}${field('Default warranty (days)', inp('default_warranty_days', S.default_warranty_days, 'type="number"'))}${field('Diagnostic fee', inp('diagnostic_fee', S.diagnostic_fee, 'type="number" step="0.01"'))}</div>
      ${field('Statuses (one per line, in workflow order)', `<textarea name="ticket_statuses" rows="8">${esc(S.ticket_statuses.join('\n'))}</textarea>`)}
      ${field('Closed statuses (one per line)', `<textarea name="closed_statuses">${esc(S.closed_statuses.join('\n'))}</textarea>`)}
      ${field('Notify customer when status becomes (one per line)', `<textarea name="notify_statuses">${esc(S.notify_statuses.join('\n'))}</textarea>`)}
      ${field('Device checklist items (one per line)', `<textarea name="checklist" rows="8">${esc(S.checklist.join('\n'))}</textarea>`)}
      <div class="grid g2">${field('Repair types (one per line — used for profit reports)', `<textarea name="repair_types" rows="8">${esc((S.repair_types || []).join('\n'))}</textarea>`)}
      ${field('Extra ticket fields (one per line, e.g. VIN, Mileage, Color)', `<textarea name="ticket_custom_fields" rows="8" placeholder="VIN\nMileage\nColor">${esc((S.ticket_custom_fields || []).join('\n'))}</textarea>`)}</div>
      ${field('Technician commission is a % of', sel('commission_basis', [['profit', 'Profit (repair revenue − parts cost)'], ['revenue', 'Revenue (before tax)']], S.commission_basis))}
      <p class="small muted">Email/SMS notifications are sent when SMTP or Twilio settings are present in the server's environment (see README).</p><button class="btn primary">Save</button></form>`;
    $('#sf').onsubmit = act(async (e) => { const v = form(e.target); const lines = (k) => v[k].split('\n').map((x) => x.trim()).filter(Boolean); S = await PUT('/settings', { ticket_prefix: v.ticket_prefix, invoice_prefix: v.invoice_prefix, default_warranty_days: v.default_warranty_days, diagnostic_fee: v.diagnostic_fee, ticket_statuses: lines('ticket_statuses'), closed_statuses: lines('closed_statuses'), notify_statuses: lines('notify_statuses'), checklist: lines('checklist'), repair_types: lines('repair_types'), ticket_custom_fields: lines('ticket_custom_fields'), commission_basis: v.commission_basis }); toast('Saved'); });
  }
  if (tab === 'users') {
    const users = await GET('/users');
    t.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h2>Team</h2><button class="btn primary" id="nu">+ Add user</button></div><table><tr><th>Name</th><th>Email</th><th>Role</th><th class="right">Commission</th><th>Status</th><th></th></tr>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td class="right">${u.commission_rate ? u.commission_rate + '%' : '—'}</td><td>${u.active ? '<span class="pill ok">active</span>' : '<span class="pill">disabled</span>'}</td><td class="right"><button class="btn sm" data-u="${u.id}">Edit</button></td></tr>`).join('')}</table>
      <p class="small muted">Roles: <b>tech</b> – tickets, customers, POS · <b>manager</b> – plus inventory, purchasing, reports, voids · <b>admin</b> – plus settings, users, API keys. No per-seat limits.</p></div>`;
    const edit = (u) => { const m = modal(`<h2>${u ? 'Edit' : 'Add'} user</h2><form id="uf">${field('Name', inp('name', u?.name, 'required autofocus'))}${field('Email', inp('email', u?.email, 'type="email" required'))}${field('Role', sel('role', ['tech', 'manager', 'admin'], u?.role || 'tech'))}${field(`Commission % (of ${S.commission_basis === 'revenue' ? 'revenue' : 'profit'} on their repairs)`, inp('commission_rate', u?.commission_rate || 0, 'type="number" min="0" max="100" step="0.5"'))}${field(u ? 'New password (leave blank to keep)' : 'Password (8+ characters)', inp('password', '', `type="password" ${u ? '' : 'required minlength="8"'}`))}${u ? `<label class="check" style="margin-bottom:12px"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Active</label>` : ''}<button class="btn primary">Save</button></form>`);
      $('#uf', m).onsubmit = act(async (e) => { const f = form(e.target); if (!f.password) delete f.password; u ? await PUT('/users/' + u.id, f) : await POST('/users', f); closeModal(); pageSettings(el, 'users'); }); };
    $('#nu').onclick = () => edit(null); $$('[data-u]', t).forEach((b) => (b.onclick = () => edit(users.find((u) => u.id == b.dataset.u))));
  }
  if (tab === 'ai') {
    const keys = await GET('/api-keys');
    const base = (S.public_url || location.origin).replace(/\/$/, '');
    t.innerHTML = `<div class="grid g2"><div class="card"><h2>Connect Claude or ChatGPT</h2>
      <p>OpenRepairPOS includes an <b>MCP server</b>, so AI assistants can look up tickets, quote repairs, book appointments, check stock and run reports for you.</p>
      <h3>1. Create a key</h3><p class="small">Create an API key below and copy it (it's shown once).</p>
      <h3>2. Add the connector</h3><div class="small"><b>Claude</b> (claude.ai or desktop): Settings → Connectors → Add custom connector → paste the URL below.<br><b>ChatGPT</b>: Settings → Apps & Connectors → Advanced → Developer mode → Create connector → paste the URL, authentication “No authentication”.<br><b>Claude Code</b>: <span class="mono">claude mcp add --transport http openrepairpos ${esc(base)}/mcp --header "Authorization: Bearer YOUR_KEY"</span></div>
      <div class="code" style="margin-top:8px">${esc(base)}/mcp/YOUR_KEY</div>
      <p class="small muted">Your server must be reachable from the internet over HTTPS for Claude.ai and ChatGPT to connect (see README → Deploy). Treat the URL like a password.</p></div>
      <div class="card"><div class="row" style="justify-content:space-between"><h2>API keys</h2><button class="btn primary" id="nk">+ Create key</button></div><div id="newkey"></div>
      ${keys.length ? `<table><tr><th>Name</th><th>Key</th><th>Last used</th><th></th></tr>${keys.map((k) => `<tr><td>${esc(k.name)}</td><td class="mono">${esc(k.prefix)}…</td><td>${k.last_used_at ? dt(k.last_used_at) : 'never'}</td><td class="right"><button class="btn sm danger" data-k="${k.id}">Revoke</button></td></tr>`).join('')}</table>` : '<div class="muted">No keys yet.</div>'}
      <p class="small muted">The same keys work for the REST API: <span class="mono">Authorization: Bearer orp_…</span> on any <span class="mono">/api/…</span> endpoint.</p></div></div>`;
    $('#nk').onclick = act(async () => { const name = prompt('Name this key (e.g. "Claude", "ChatGPT", "Zapier")', 'Claude'); if (!name) return; const k = await POST('/api-keys', { name }); await pageSettings(el, 'ai'); $('#newkey').innerHTML = `<div class="card p4c" style="margin:10px 0"><b>Copy now — it won't be shown again.</b><div class="code" style="margin-top:6px">MCP URL: ${esc(base)}/mcp/${esc(k.key)}\nKey: ${esc(k.key)}</div><p class="small muted" style="margin:6px 0">Prefer the header form (Authorization: Bearer …) where your AI client supports it — URLs can end up in logs.</p><button class="btn sm" id="cp">Copy MCP URL</button></div>`; $('#cp').onclick = () => navigator.clipboard.writeText(`${base}/mcp/${k.key}`).then(() => toast('Copied')); });
    $$('[data-k]', t).forEach((b) => (b.onclick = act(async () => { if (!confirm('Revoke this key? Connected assistants will stop working.')) return; await DEL('/api-keys/' + b.dataset.k); pageSettings(el, 'ai'); })));
  }
  if (tab === 'integrations') {
    const EVENTS = ['ticket.created', 'ticket.status_changed', 'ticket.deposit', 'invoice.created', 'invoice.paid', 'invoice.voided', 'customer.created', 'appointment.booked', 'stock.low'];
    const hooks = [...(S.webhooks || [])];
    const draw = () => {
      t.innerHTML = `<div class="card"><h2>Webhooks</h2><p>Send events to other apps — Zapier, Make, n8n, Google Sheets, your own scripts or a plugin. OpenRepairPOS POSTs JSON to each URL when the selected events happen.</p>
        ${hooks.map((h, i) => `<div class="card" style="margin-bottom:10px;box-shadow:none"><div class="row"><input class="grow" data-url="${i}" value="${esc(h.url)}" placeholder="https://hooks.zapier.com/…"><button class="btn sm danger" data-del="${i}">Remove</button></div>
          <div class="checks" style="margin-top:8px"><label class="check"><input type="checkbox" data-ev="${i}" value="*" ${(h.events || ['*']).includes('*') ? 'checked' : ''}> All events</label>${EVENTS.map((e) => `<label class="check"><input type="checkbox" data-ev="${i}" value="${e}" ${(h.events || []).includes(e) ? 'checked' : ''}> ${e}</label>`).join('')}</div></div>`).join('') || '<div class="muted" style="margin-bottom:10px">No webhooks yet.</div>'}
        <div class="row"><button class="btn" id="wadd">+ Add webhook</button><button class="btn primary" id="wsave">Save</button><button class="btn" id="wtest">Send test event</button></div>
        <p class="small muted">Each request has a JSON body <span class="mono">{ event, at, data }</span>. Set a <span class="mono">WEBHOOK_SECRET</span> environment variable to sign requests (header <span class="mono">X-OpenRepairPOS-Signature</span>, HMAC-SHA256). For deeper integrations use the REST API or MCP keys from the AI & API tab.</p></div>`;
      const collect = () => hooks.forEach((h, i) => { h.url = $(`[data-url="${i}"]`, t).value.trim(); const ev = $$(`[data-ev="${i}"]:checked`, t).map((x) => x.value); h.events = ev.includes('*') || !ev.length ? ['*'] : ev; });
      $('#wadd', t).onclick = () => { collect(); hooks.push({ url: '', events: ['*'] }); draw(); };
      $$('[data-del]', t).forEach((b) => (b.onclick = () => { collect(); hooks.splice(Number(b.dataset.del), 1); draw(); }));
      $('#wsave', t).onclick = act(async () => { collect(); S = await PUT('/settings', { webhooks: hooks.filter((h) => h.url) }); toast('Webhooks saved'); });
      $('#wtest', t).onclick = act(async () => { await POST('/webhooks/test'); toast('Test event sent to saved webhooks'); });
    };
    draw();
  }
  if (tab === 'parts') {
    t.innerHTML = `<form class="card p4c" id="sf"><h2>Parts4Cells</h2><p>OpenRepairPOS includes reorder links to Parts4Cells, a Houston, Texas wholesaler of phone and tablet replacement parts. Low-stock items get a "Find on Parts4Cells" link and purchase orders suggest Parts4Cells as the supplier. You can still buy from any supplier: just type its name on the purchase order or item.</p>
      ${field('Your Parts4Cells account email (optional, for your reference)', inp('p4c_account_email', S.p4c_account_email, 'type="email"'))}
      <div class="row"><button class="btn primary">Save</button><a class="btn" href="https://parts4cells.com" target="_blank" rel="noopener">Open Parts4Cells ↗</a></div>
      <p class="small muted">Tip: store the Parts4Cells SKU in each item's “Supplier SKU” field for exact matches. Nothing about your shop is sent to Parts4Cells.</p></form>`;
    $('#sf').onsubmit = saveForm($('#sf'), ['p4c_account_email']);
  }

}

window.closeModal = closeModal;
boot();
