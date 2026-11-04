// Business logic shared by the web API and the MCP server.
// Every function takes plain objects and returns plain objects, so both front doors behave identically.
const crypto = require('node:crypto');
const { tx, all, get, run } = require('./db');
const notify = require('./notify');

// Database constraint errors become clear messages instead of "Server error".
function friendlyError(e) {
  if (e instanceof AppError) return e;
  const m = String(e?.message || '');
  if (/UNIQUE constraint failed: items\.sku/i.test(m)) return new AppError('An item with that SKU already exists');
  if (/UNIQUE constraint failed: items\.barcode/i.test(m)) return new AppError('An item with that barcode already exists');
  if (/UNIQUE constraint failed: users\.email/i.test(m)) return new AppError('A user with that email already exists');
  if (/UNIQUE constraint failed/i.test(m)) return new AppError('That record already exists');
  if (/FOREIGN KEY constraint failed/i.test(m)) return new AppError('This refers to a customer, item or record that does not exist');
  if (/NOT NULL constraint failed|CHECK constraint failed|datatype mismatch/i.test(m)) return new AppError('Some required information is missing or invalid');
  return null;
}
class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const notFound = (what) => new AppError(`${what} not found`, 404);
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
// Coerce untrusted input to a number (never store text in numeric columns).
const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const int = (v, def = 0) => Math.trunc(num(v, def));
const lim = (v, def) => Math.min(Math.max(int(v, def), 1), 5000);
const posQty = (v) => { const n = num(v, 1); if (!(n > 0)) throw new AppError('Quantity must be greater than zero'); return n; };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const dateOnly = (v) => (v ? String(v).slice(0, 10) : '');
// The shop's local time. Timestamps are stored in UTC; reports and "today" use the shop's time zone.
const tzFormatters = new Map();
function tzOffsetMinutes(tz, d = new Date()) {
  try {
    let f = tzFormatters.get(tz);
    if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); tzFormatters.set(tz, f); }
    const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
    const local = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    return Math.round((local - Math.floor(d.getTime() / 60000) * 60000) / 60000);
  } catch { return 0; }
}
// Offset changes (daylight saving) for the shop's zone, so a sale is counted on the local day it happened, in any season.
const tzRuleCache = new Map();
function tzRules(tz) {
  const year = new Date().getUTCFullYear();
  const key = `${tz}|${year}`;
  if (tzRuleCache.has(key)) return tzRuleCache.get(key);
  const DAY = 864e5, Q = 9e5;
  let t = Date.UTC(2015, 0, 1);
  const end = Date.UTC(year + 2, 0, 1);
  const rules = { first: tzOffsetMinutes(tz, new Date(t)), changes: [] }; // changes: [utcIso, offsetFromThen]
  let prev = rules.first;
  for (; t < end; t += DAY) {
    const o = tzOffsetMinutes(tz, new Date(t + DAY));
    if (o === prev) continue;
    let u = t; // find the exact quarter hour the change happened
    while (u < t + DAY && tzOffsetMinutes(tz, new Date(u)) === prev) u += Q;
    rules.changes.push([new Date(u).toISOString().slice(0, 19).replace('T', ' '), o]);
    prev = o;
  }
  tzRuleCache.set(key, rules);
  return rules;
}
// SQL expression for the shop-local calendar day of a UTC timestamp column (all values are generated here, safe to inline).
function localDay(col) {
  const { first, changes } = tzRules(getSettings().timezone);
  if (!changes.length) return `date(${col}, '${first} minutes')`;
  let expr = 'CASE';
  let cur = first;
  for (const [at, o] of changes) { expr += ` WHEN datetime(${col}) < '${at}' THEN '${cur} minutes'`; cur = o; }
  return `date(${col}, ${expr} ELSE '${cur} minutes' END)`;
}
const localToday = () => new Date(Date.now() + tzOffsetMinutes(getSettings().timezone) * 60000).toISOString().slice(0, 10);
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- settings
const DEFAULT_SETTINGS = {
  store_name: 'My Repair Shop',
  store_phone: '',
  store_email: '',
  store_address: '',
  store_hours: 'Mon–Sat 10:00–19:00',
  currency: 'USD',
  timezone: 'America/Chicago',
  tax_rate: 8.25,
  ticket_prefix: 'T-',
  invoice_prefix: 'INV-',
  po_prefix: 'PO-',
  default_warranty_days: 90,
  diagnostic_fee: 30,
  ticket_statuses: [
    'New', 'Diagnosing', 'Waiting for approval', 'Waiting for parts',
    'In repair', 'Ready for pickup', 'Completed', 'Cancelled',
  ],
  closed_statuses: ['Completed', 'Cancelled'],
  notify_statuses: ['Waiting for approval', 'Waiting for parts', 'Ready for pickup'],
  checklist: ['Powers on', 'Screen / touch', 'Cameras', 'Speakers / mic', 'Charging port', 'Buttons', 'Face ID / Touch ID', 'Wi‑Fi / cellular', 'Water damage indicator'],
  terms: 'We are not responsible for data loss. Devices not collected within 60 days may be recycled. Repairs carry a warranty on parts and labor for the stated period; physical or liquid damage voids warranty.',
  public_url: '',
  p4c_enabled: true,
  // The utm_* tag only names the source of the visit (OpenRepairPOS). It carries nothing about the shop.
  p4c_search_url: 'https://parts4cells.com/catalogsearch/result/?q={query}&utm_source=openrepairpos&utm_medium=referral&utm_campaign=app_parts_links',
  p4c_account_email: '',
  repair_types: ['Screen replacement', 'Battery replacement', 'Charging port', 'Back glass', 'Camera', 'Water damage', 'Diagnostics', 'Data recovery', 'Software', 'Other'],
  ticket_custom_fields: [],      // extra fields on every ticket, e.g. ["VIN", "Mileage", "Color"]
  commission_basis: 'profit',    // 'profit' (revenue − parts cost) or 'revenue' (before tax)
  webhooks: [],                  // [{ url, events: ['*'] | ['ticket.created', ...] }]
};
const WEBHOOK_EVENTS = ['ticket.created', 'ticket.status_changed', 'ticket.deposit', 'invoice.created', 'invoice.paid', 'invoice.voided', 'customer.created', 'appointment.booked', 'stock.low'];

// Fire webhooks for an event. Never blocks or fails the action that caused it.
function emit(event, data) {
  const hooks = (getSettings().webhooks || []).filter((h) => h?.url && (event === 'test' || !h.events?.length || h.events.includes('*') || h.events.includes(event)));
  for (const h of hooks) notify.webhook(h.url, { event, at: now(), data });
}

// Settings shops cannot change: the Parts4Cells integration is always on.
const FIXED_SETTINGS = ['p4c_enabled', 'p4c_search_url'];
function getSettings() {
  const s = { ...DEFAULT_SETTINGS };
  for (const r of all('SELECT key, value FROM settings')) {
    if (FIXED_SETTINGS.includes(r.key)) continue;
    try { s[r.key] = JSON.parse(r.value); } catch { s[r.key] = r.value; }
  }
  return s;
}
function updateSettings(patch) {
  if ('webhooks' in patch) {
    if (!Array.isArray(patch.webhooks)) throw new AppError('webhooks must be a list');
    patch.webhooks = patch.webhooks.filter((h) => h && h.url).map((h) => {
      if (!/^https:\/\//i.test(h.url)) throw new AppError(`Webhook URL must start with https:// (${h.url})`);
      const events = (h.events || ['*']).filter((e) => e === '*' || WEBHOOK_EVENTS.includes(e));
      return { url: String(h.url).trim(), events: events.length ? events : ['*'] };
    });
  }
  if ('commission_basis' in patch && !['profit', 'revenue'].includes(patch.commission_basis)) throw new AppError('commission_basis must be profit or revenue');
  const LISTS = ['ticket_statuses', 'closed_statuses', 'notify_statuses', 'checklist', 'repair_types', 'ticket_custom_fields'];
  for (const k of LISTS) {
    if (!(k in patch)) continue;
    if (!Array.isArray(patch[k])) throw new AppError(`${k} must be a list`);
    patch[k] = [...new Set(patch[k].map((x) => String(x).trim()).filter(Boolean))];
  }
  const cur = getSettings();
  const statuses = patch.ticket_statuses || cur.ticket_statuses;
  if (!statuses.length) throw new AppError('You need at least one ticket status');
  for (const k of ['closed_statuses', 'notify_statuses']) {
    const bad = (patch[k] || cur[k]).filter((x) => !statuses.includes(x));
    if (bad.length && k in patch) throw new AppError(`${k} contains unknown statuses: ${bad.join(', ')}`);
    if (bad.length) patch[k] = cur[k].filter((x) => statuses.includes(x));
  }
  for (const k of ['tax_rate', 'default_warranty_days', 'diagnostic_fee']) if (k in patch) { patch[k] = num(patch[k]); if (patch[k] < 0) throw new AppError(`${k} cannot be negative`); }
  if ('timezone' in patch) { try { new Intl.DateTimeFormat('en-US', { timeZone: patch.timezone }); } catch { throw new AppError('Unknown time zone'); } }
  if ('currency' in patch) { patch.currency = String(patch.currency).trim().toUpperCase(); if (!/^[A-Z]{3}$/.test(patch.currency)) throw new AppError('Currency must be a 3-letter code like USD'); }
  if ('public_url' in patch && patch.public_url && !/^https?:\/\/[^\s"'<>]+$/i.test(patch.public_url)) throw new AppError('Public URL must start with https://');
  tx(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k) || FIXED_SETTINGS.includes(k)) continue;
      run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
    }
  });
  return getSettings();
}

function nextNumber(table, prefix) {
  const r = get(`SELECT COUNT(*) AS c FROM ${table}`);
  let n = r.c + 1001;
  while (get(`SELECT 1 FROM ${table} WHERE number = ?`, prefix + n)) n++;
  return prefix + n;
}

function audit(actor, action, detail = '') {
  run('INSERT INTO audit_log (actor, action, detail) VALUES (?, ?, ?)', actor || 'system', action, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

// ---------------------------------------------------------------- customers
function searchCustomers({ q = '', limit = 50 } = {}) {
  const like = `%${q.trim()}%`;
  const digits = q.replace(/\D/g, '');
  return all(
    `SELECT c.*, (SELECT COUNT(*) FROM tickets t WHERE t.customer_id = c.id) AS ticket_count
     FROM customers c
     WHERE ? = '' OR (c.first_name || ' ' || c.last_name) LIKE ? OR c.email LIKE ? OR c.company LIKE ?
        OR (? <> '' AND replace(replace(replace(replace(c.phone,'-',''),' ',''),'(',''),')','') LIKE ?)
     ORDER BY c.id DESC LIMIT ?`,
    q.trim(), like, like, like, digits, `%${digits}%`, lim(limit, 50),
  );
}
function getCustomer(id) {
  const c = get('SELECT * FROM customers WHERE id = ?', id);
  if (!c) throw notFound('Customer');
  c.tickets = all('SELECT id, number, status, brand, model, issue, created_at FROM tickets WHERE customer_id = ? ORDER BY id DESC', id);
  c.invoices = all('SELECT id, number, status, total, paid, created_at FROM invoices WHERE customer_id = ? ORDER BY id DESC', id);
  return c;
}
function saveCustomer(data, id = null) {
  const f = ['first_name', 'last_name', 'phone', 'email', 'company', 'address', 'notes'];
  if (!id && !data.first_name) throw new AppError('first_name is required');
  if (id) {
    if (!get('SELECT 1 FROM customers WHERE id = ?', id)) throw notFound('Customer');
    const sets = f.filter((k) => k in data);
    if (sets.length) run(`UPDATE customers SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...sets.map((k) => String(data[k] ?? '')), id);
    return getCustomer(id);
  }
  const r = run(`INSERT INTO customers (${f.join(',')}) VALUES (${f.map(() => '?').join(',')})`, ...f.map((k) => String(data[k] ?? '')));
  const c = getCustomer(Number(r.lastInsertRowid));
  emit('customer.created', { id: c.id, first_name: c.first_name, last_name: c.last_name, phone: c.phone, email: c.email });
  return c;
}

// ---------------------------------------------------------------- inventory
function searchItems({ q = '', kind = '', low = false, limit = 200 } = {}) {
  const like = `%${q.trim()}%`;
  return all(
    `SELECT * FROM items WHERE active = 1
       AND (? = '' OR name LIKE ? OR sku LIKE ? OR barcode = ? OR category LIKE ? OR supplier_sku LIKE ?)
       AND (? = '' OR kind = ?)
       AND (? = 0 OR (kind <> 'service' AND stock <= min_stock))
     ORDER BY name LIMIT ?`,
    q.trim(), like, like, q.trim(), like, like, kind, kind, low ? 1 : 0, lim(limit, 200),
  );
}
function getItem(id) {
  const i = get('SELECT * FROM items WHERE id = ?', id);
  if (!i) throw notFound('Item');
  i.moves = all('SELECT * FROM stock_moves WHERE item_id = ? ORDER BY id DESC LIMIT 50', id);
  i.serials = all("SELECT * FROM serials WHERE item_id = ? ORDER BY id DESC LIMIT 200", id);
  return i;
}
function saveItem(data, id = null, actor) {
  const f = ['sku', 'name', 'category', 'kind', 'cost', 'price', 'min_stock', 'supplier', 'supplier_sku', 'barcode', 'taxable'];
  const val = (k) => (['cost', 'price', 'min_stock'].includes(k) ? Number(data[k]) || 0 : k === 'taxable' ? (data[k] === false || data[k] === 0 ? 0 : 1) : k === 'sku' ? (data[k] ? String(data[k]) : null) : String(data[k] ?? ''));
  return tx(() => {
    if (id) {
      if (!get('SELECT 1 FROM items WHERE id = ?', id)) throw notFound('Item');
      const sets = f.filter((k) => k in data);
      if (sets.length) run(`UPDATE items SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...sets.map(val), id);
      return getItem(id);
    }
    if (!data.name) throw new AppError('name is required');
    if (!data.kind) data.kind = 'part';
    if (!data.sku) data.sku = 'SKU' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
    const r = run(`INSERT INTO items (${f.join(',')}) VALUES (${f.map(() => '?').join(',')})`, ...f.map(val));
    const newId = Number(r.lastInsertRowid);
    if (Number(data.stock)) adjustStock({ item_id: newId, qty: Number(data.stock), reason: 'Opening stock' }, actor);
    return getItem(newId);
  });
}
function deleteItem(id) {
  run('UPDATE items SET active = 0 WHERE id = ?', id);
  return { ok: true };
}
function adjustStock({ item_id, qty, reason = 'Adjustment', ref = '' }, actor) {
  qty = num(qty, NaN);
  if (!Number.isFinite(qty) || qty === 0) throw new AppError('Quantity must be a non-zero number');
  const item = get('SELECT * FROM items WHERE id = ?', item_id);
  if (!item) throw notFound('Item');
  if (item.kind === 'service') return item;
  run('UPDATE items SET stock = stock + ? WHERE id = ?', qty, item_id);
  run('INSERT INTO stock_moves (item_id, qty, reason, ref, user_id) VALUES (?, ?, ?, ?, ?)', item_id, qty, reason, ref, actor?.id || null);
  const after = get('SELECT * FROM items WHERE id = ?', item_id);
  if (qty < 0 && item.stock > item.min_stock && after.stock <= after.min_stock) emit('stock.low', { id: after.id, name: after.name, sku: after.sku, supplier_sku: after.supplier_sku, stock: after.stock, min_stock: after.min_stock });
  return after;
}
// CSV import: all rows or none, with the failing row named.
function importItems(items, actor) {
  if (!Array.isArray(items)) throw new AppError('items must be a list');
  return tx(() => items.map((it, i) => {
    try { return saveItem(it, null, actor); } catch (e) { const f = friendlyError(e); if (!f) throw e; throw new AppError(`Row ${i + 1}: ${f.message}. Nothing was imported.`); }
  }));
}
function stockCount({ counts } = {}, actor) {
  if (!Array.isArray(counts)) throw new AppError('counts must be a list of { item_id, counted }');
  // counts: [{item_id, counted}] — sets stock to the physical count and logs the difference
  return tx(() => counts.filter((c) => c.counted !== '' && c.counted !== null && Number.isFinite(Number(c.counted))).map(({ item_id, counted }) => {
    const item = get('SELECT stock FROM items WHERE id = ?', item_id);
    if (!item) throw notFound('Item');
    const diff = Number(counted) - item.stock;
    return diff ? adjustStock({ item_id, qty: diff, reason: 'Stock count' }, actor) : get('SELECT * FROM items WHERE id = ?', item_id);
  }));
}
function addSerials({ item_id, serials }, actor) {
  return tx(() => {
    for (const s of serials.filter(Boolean)) run('INSERT INTO serials (item_id, serial) VALUES (?, ?)', item_id, s.trim());
    return getItem(item_id);
  });
}

// ---------------------------------------------------------------- price list (repair quotes)
function listPrices({ q = '' } = {}) {
  const like = `%${q}%`;
  return all(
    `SELECT p.*, i.name AS part_name, i.stock AS part_stock FROM price_list p LEFT JOIN items i ON i.id = p.item_id
     WHERE ? = '' OR (p.brand || ' ' || p.model || ' ' || p.repair) LIKE ? ORDER BY p.brand, p.model, p.repair`,
    q, like,
  );
}
function savePrice(data, id = null) {
  const f = ['brand', 'model', 'repair', 'price', 'item_id', 'minutes', 'warranty_days'];
  const v = (k) => (k === 'item_id' ? (data[k] ? Number(data[k]) : null) : ['price', 'minutes', 'warranty_days'].includes(k) ? Number(data[k]) || 0 : String(data[k] ?? ''));
  if (id) {
    const sets = f.filter((k) => k in data);
    run(`UPDATE price_list SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...sets.map(v), id);
    return get('SELECT * FROM price_list WHERE id = ?', id);
  }
  const r = run(`INSERT INTO price_list (${f.join(',')}) VALUES (${f.map(() => '?').join(',')})`, ...f.map(v));
  return get('SELECT * FROM price_list WHERE id = ?', Number(r.lastInsertRowid));
}
function deletePrice(id) { run('DELETE FROM price_list WHERE id = ?', id); return { ok: true }; }

function quoteRepair({ device = '', repair = '' }) {
  // Fuzzy match: every word the caller gave must appear somewhere in brand/model/repair.
  const words = `${device} ${repair}`.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const rows = listPrices().filter((p) => {
    const hay = `${p.brand} ${p.model} ${p.repair}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const s = getSettings();
  return {
    matches: rows.slice(0, 10).map((p) => ({
      device: `${p.brand} ${p.model}`, repair: p.repair, price: p.price, currency: s.currency,
      est_minutes: p.minutes, warranty_days: p.warranty_days,
      part_in_stock: p.item_id ? (p.part_stock || 0) > 0 : null,
    })),
    note: rows.length ? undefined : `No exact price on file. Diagnostic fee is ${s.diagnostic_fee} ${s.currency}; the device needs to be inspected in store for a quote.`,
  };
}

// ---------------------------------------------------------------- tickets
function parseTicket(t) {
  if (!t) return t;
  for (const k of ['pre_checklist', 'post_checklist', 'custom']) { try { t[k] = JSON.parse(t[k] || '{}'); } catch { t[k] = {}; } }
  return t;
}
function listTickets({ q = '', status = '', open = false, assigned_to = null, customer_id = null, limit = 200 } = {}) {
  const s = getSettings();
  const like = `%${q.trim()}%`;
  const closed = s.closed_statuses;
  const rows = all(
    `SELECT t.id, t.number, t.status, t.priority, t.due_date, t.device_type, t.brand, t.model, t.serial, t.issue,
            t.estimate, t.created_at, t.updated_at, t.tracking_code, t.invoice_id, t.customer_id,
            c.first_name || ' ' || c.last_name AS customer_name, c.phone AS customer_phone,
            u.name AS assigned_name, t.assigned_to
     FROM tickets t JOIN customers c ON c.id = t.customer_id LEFT JOIN users u ON u.id = t.assigned_to
     WHERE (? = '' OR t.number LIKE ? OR t.serial LIKE ? OR t.brand || ' ' || t.model LIKE ?
            OR c.first_name || ' ' || c.last_name LIKE ? OR c.phone LIKE ? OR t.issue LIKE ?)
       AND (? = '' OR t.status = ?)
       AND (? IS NULL OR t.assigned_to = ?)
       AND (? IS NULL OR t.customer_id = ?)
       AND (? = 0 OR t.status NOT IN (SELECT value FROM json_each(?)))
     ORDER BY CASE WHEN t.due_date IS NULL OR t.due_date = '' THEN 1 ELSE 0 END, t.due_date, t.id DESC
     LIMIT ?`,
    q.trim(), like, like, like, like, like, like, status, status,
    assigned_to, assigned_to, customer_id, customer_id, open ? 1 : 0, JSON.stringify(closed),
    lim(limit, 200),
  );
  const today = localToday();
  return rows
    .map((t) => ({ ...t, overdue: !!t.due_date && t.due_date < today && !closed.includes(t.status) }));
}
function getTicket(idOrNumber) {
  const t = parseTicket(get(
    `SELECT t.*, c.first_name || ' ' || c.last_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
            u.name AS assigned_name
     FROM tickets t JOIN customers c ON c.id = t.customer_id LEFT JOIN users u ON u.id = t.assigned_to
     WHERE t.id = ? OR t.number = ?`, Number(idOrNumber) || -1, String(idOrNumber)));
  if (!t) throw notFound('Ticket');
  t.notes = all('SELECT n.*, u.name AS user_name FROM ticket_notes n LEFT JOIN users u ON u.id = n.user_id WHERE ticket_id = ? ORDER BY n.id DESC', t.id);
  t.items = all('SELECT * FROM ticket_items WHERE ticket_id = ? ORDER BY id', t.id);
  t.items_total = money(t.items.reduce((a, i) => a + i.qty * i.unit_price, 0));
  t.deposits = all('SELECT d.*, u.name AS user_name FROM ticket_deposits d LEFT JOIN users u ON u.id = d.user_id WHERE ticket_id = ? ORDER BY d.id', t.id);
  t.deposit_total = money(t.deposits.filter((d) => !d.invoice_id).reduce((a, d) => a + d.amount, 0));
  t.time = all('SELECT tt.*, u.name AS user_name FROM ticket_time tt JOIN users u ON u.id = tt.user_id WHERE ticket_id = ? ORDER BY tt.id DESC', t.id);
  t.minutes_total = Math.round(t.time.reduce((a, x) => a + (x.stopped_at ? x.minutes : (Date.now() - Date.parse(x.started_at)) / 60000), 0));
  return t;
}
function createTicket(data, actor) {
  const s = getSettings();
  return tx(() => {
    let customerId = data.customer_id;
    if (!customerId && data.customer) customerId = saveCustomer(data.customer).id;
    if (!customerId || !get('SELECT 1 FROM customers WHERE id = ?', customerId)) throw new AppError('A valid customer_id (or a new customer) is required');
    if (data.status && !s.ticket_statuses.includes(data.status)) throw new AppError(`Unknown status. Valid: ${s.ticket_statuses.join(', ')}`);
    checkTicketFields(data);
    const number = nextNumber('tickets', s.ticket_prefix);
    const tracking = crypto.randomBytes(6).toString('hex');
    const r = run(
      `INSERT INTO tickets (number, customer_id, status, priority, assigned_to, due_date, device_type, brand, model, serial,
                            passcode, issue, pre_checklist, estimate, warranty_days, tracking_code, created_by, repair_type, custom)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      number, customerId, data.status || s.ticket_statuses[0], data.priority || 'normal', data.assigned_to || null,
      data.due_date || null, String(data.device_type || ''), String(data.brand || ''), String(data.model || ''), String(data.serial || ''),
      String(data.passcode || ''), String(data.issue || ''), JSON.stringify(data.pre_checklist || {}), money(data.estimate),
      int(data.warranty_days ?? s.default_warranty_days, s.default_warranty_days), tracking, actor?.id || null, String(data.repair_type || ''), JSON.stringify(cleanCustom(data.custom)),
    );
    const id = Number(r.lastInsertRowid);
    addNote({ ticket_id: id, type: 'system', body: `Ticket created by ${actor?.name || 'system'}` }, actor);
    for (const it of data.items || []) addTicketItem({ ticket_id: id, ...it }, actor);
    if (Number(data.deposit?.amount) > 0) addDeposit({ ticket_id: id, ...data.deposit }, actor);
    audit(actor?.name, 'ticket.create', number);
    const full = getTicket(id);
    emit('ticket.created', { id: full.id, number: full.number, status: full.status, device: [full.brand, full.model].filter(Boolean).join(' '), repair_type: full.repair_type, issue: full.issue, estimate: full.estimate, due_date: full.due_date, tracking_code: full.tracking_code, customer: { id: full.customer_id, name: full.customer_name, phone: full.customer_phone, email: full.customer_email } });
    return full;
  });
}
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
function cleanCustom(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return {};
  return Object.fromEntries(Object.entries(c).slice(0, 30).map(([k, v]) => [String(k).slice(0, 60), String(v ?? '').slice(0, 500)]));
}
// Validates and normalises editable ticket fields in place.
function checkTicketFields(data) {
  if ('priority' in data && data.priority && !PRIORITIES.includes(data.priority)) throw new AppError(`priority must be one of ${PRIORITIES.join(', ')}`);
  if ('assigned_to' in data) {
    data.assigned_to = data.assigned_to ? int(data.assigned_to) : null;
    if (data.assigned_to && !get('SELECT 1 FROM users WHERE id = ?', data.assigned_to)) throw new AppError('Unknown technician');
  }
  if ('due_date' in data) { data.due_date = data.due_date ? dateOnly(data.due_date) : null; if (data.due_date && !isDate(data.due_date)) throw new AppError('due_date must be YYYY-MM-DD'); }
  if ('estimate' in data) data.estimate = money(data.estimate);
  if ('warranty_days' in data) data.warranty_days = Math.max(0, int(data.warranty_days));
  if ('custom' in data) data.custom = cleanCustom(data.custom);
  for (const k of ['device_type', 'brand', 'model', 'serial', 'passcode', 'issue', 'repair_type']) if (k in data && data[k] != null) data[k] = String(data[k]);
  if ('signature' in data && data.signature && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.signature)) throw new AppError('Invalid signature image');
}
function updateTicket(id, data, actor) {
  const t = getTicket(id);
  const s = getSettings();
  const f = ['priority', 'assigned_to', 'due_date', 'device_type', 'brand', 'model', 'serial', 'passcode', 'issue', 'estimate', 'warranty_days', 'pre_checklist', 'post_checklist', 'signature', 'repair_type', 'custom'];
  checkTicketFields(data);
  return tx(() => {
    const sets = f.filter((k) => k in data);
    if (sets.length) {
      run(`UPDATE tickets SET ${sets.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ...sets.map((k) => (k.endsWith('checklist') || k === 'custom' ? JSON.stringify(data[k] || {}) : data[k] ?? null)), now(), t.id);
    }
    if ('signature' in data && data.signature) run('UPDATE tickets SET terms_accepted_at = ? WHERE id = ?', now(), t.id);
    if ('assigned_to' in data && data.assigned_to !== t.assigned_to) {
      const u = data.assigned_to ? get('SELECT name FROM users WHERE id = ?', data.assigned_to) : null;
      addNote({ ticket_id: t.id, type: 'system', body: `Assigned to ${u?.name || 'nobody'}` }, actor);
    }
    if (data.status && data.status !== t.status) setTicketStatus({ ticket_id: t.id, status: data.status }, actor);
    return getTicket(t.id);
  });
}
function setTicketStatus({ ticket_id, status, notify_customer = true }, actor) {
  const s = getSettings();
  if (!s.ticket_statuses.includes(status)) throw new AppError(`Unknown status. Valid: ${s.ticket_statuses.join(', ')}`);
  const t = getTicket(ticket_id);
  if (t.status === status) return t;
  const closed = s.closed_statuses.includes(status);
  run('UPDATE tickets SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?', status, now(), closed ? now() : null, t.id);
  addNote({ ticket_id: t.id, type: 'system', body: `Status: ${t.status} → ${status}` }, actor);
  // Closing a ticket stops any running job timers.
  if (closed) for (const x of all('SELECT id FROM ticket_time WHERE ticket_id = ? AND stopped_at IS NULL', t.id)) stopTimerRow(x.id);
  emit('ticket.status_changed', { number: t.number, id: t.id, from: t.status, to: status, tracking_code: t.tracking_code, customer: { name: t.customer_name, phone: t.customer_phone, email: t.customer_email } });
  if (notify_customer && s.notify_statuses.includes(status)) {
    const fresh = getTicket(t.id);
    notify.background(notify.ticketStatus(fresh, s).then((sent) => {
      if (sent.length) addNote({ ticket_id: t.id, type: 'system', body: `Customer notified (${sent.join(', ')}): ${status}` });
    }).catch((e) => addNote({ ticket_id: t.id, type: 'system', body: `Notification failed: ${e.message}` })));
  }
  return getTicket(t.id);
}
function addNote({ ticket_id, type = 'internal', body }, actor) {
  if (!body) throw new AppError('body is required');
  if (!['internal', 'diagnostic', 'system'].includes(type)) throw new AppError('type must be internal or diagnostic');
  run('INSERT INTO ticket_notes (ticket_id, user_id, type, body) VALUES (?, ?, ?, ?)', ticket_id, actor?.id || null, type, body);
  run('UPDATE tickets SET updated_at = ? WHERE id = ?', now(), ticket_id);
  return { ok: true };
}
function addTicketItem({ ticket_id, item_id = null, description, qty = 1, unit_price, kind }, actor) {
  return tx(() => {
    const t = get('SELECT id, number, invoice_id FROM tickets WHERE id = ?', ticket_id);
    if (!t) throw notFound('Ticket');
    if (t.invoice_id) throw new AppError('Ticket is already invoiced — void the invoice first to change parts or labor');
    qty = posQty(qty);
    let item = null;
    if (item_id) { item = get('SELECT * FROM items WHERE id = ?', item_id); if (!item) throw notFound('Item'); }
    run('INSERT INTO ticket_items (ticket_id, item_id, description, qty, unit_price, unit_cost, kind, taxable) VALUES (?,?,?,?,?,?,?,?)',
      ticket_id, item_id, String(description || item?.name || 'Labor'), qty,
      Math.max(0, money(unit_price ?? item?.price ?? 0)), item?.cost ?? 0, kind || (item ? (item.kind === 'service' ? 'labor' : 'part') : 'labor'), item ? item.taxable : 1);
    // Parts are reserved from stock the moment they are attached to a repair.
    if (item && item.kind !== 'service') adjustStock({ item_id, qty: -qty, reason: 'Used in repair', ref: t.number }, actor);
    return getTicket(ticket_id);
  });
}
function removeTicketItem({ ticket_id, line_id }, actor) {
  return tx(() => {
    const line = get('SELECT * FROM ticket_items WHERE id = ? AND ticket_id = ?', line_id, ticket_id);
    if (!line) throw notFound('Line');
    const t = get('SELECT number, invoice_id FROM tickets WHERE id = ?', ticket_id);
    if (t.invoice_id) throw new AppError('Ticket is already invoiced — void the invoice first to change parts or labor');
    if (line.item_id && get("SELECT 1 FROM items WHERE id = ? AND kind <> 'service'", line.item_id)) adjustStock({ item_id: line.item_id, qty: line.qty, reason: 'Removed from repair', ref: t.number }, actor);
    run('DELETE FROM ticket_items WHERE id = ?', line_id);
    return getTicket(ticket_id);
  });
}
// ---------------------------------------------------------------- deposits (money taken before the invoice exists)
function addDeposit({ ticket_id, amount, method = 'cash', reference = '' }, actor) {
  const t = get('SELECT id, number, invoice_id FROM tickets WHERE id = ?', ticket_id);
  if (!t) throw notFound('Ticket');
  if (t.invoice_id) throw new AppError('Ticket is already invoiced — take the payment on the invoice instead');
  const amt = money(amount);
  if (!(amt > 0)) throw new AppError('Deposit amount must be greater than zero');
  if (method === 'store_credit') throw new AppError('Use store credit when paying the invoice');
  run('INSERT INTO ticket_deposits (ticket_id, method, amount, reference, user_id) VALUES (?,?,?,?,?)', t.id, method, amt, reference, actor?.id || null);
  addNote({ ticket_id: t.id, type: 'system', body: `Deposit ${amt.toFixed(2)} (${method}) received` }, actor);
  emit('ticket.deposit', { ticket: t.number, amount: amt, method });
  return getTicket(t.id);
}
function removeDeposit({ ticket_id, deposit_id }, actor) {
  const d = get('SELECT * FROM ticket_deposits WHERE id = ? AND ticket_id = ?', deposit_id, ticket_id);
  if (!d) throw notFound('Deposit');
  if (d.invoice_id) throw new AppError('Deposit is already applied to an invoice');
  run('DELETE FROM ticket_deposits WHERE id = ?', d.id);
  addNote({ ticket_id, type: 'system', body: `Deposit ${d.amount.toFixed(2)} (${d.method}) refunded/removed` }, actor);
  return getTicket(ticket_id);
}

// ---------------------------------------------------------------- job timer (time spent per ticket per technician)
function stopTimerRow(id) {
  const x = get('SELECT * FROM ticket_time WHERE id = ?', id);
  if (!x || x.stopped_at) return;
  const end = now();
  run('UPDATE ticket_time SET stopped_at = ?, minutes = ? WHERE id = ?', end, Math.max(0, (Date.parse(end) - Date.parse(x.started_at)) / 60000), id);
}
function ticketTimer({ ticket_id, action }, actor) {
  if (!actor?.id) throw new AppError('Timers need a signed-in user');
  if (!get('SELECT 1 FROM tickets WHERE id = ?', ticket_id)) throw notFound('Ticket');
  return tx(() => {
    const running = get('SELECT * FROM ticket_time WHERE user_id = ? AND stopped_at IS NULL', actor.id);
    if (action === 'start') {
      // One running timer per person: starting a new job pauses the previous one.
      if (running && running.ticket_id === Number(ticket_id)) return getTicket(ticket_id);
      if (running) stopTimerRow(running.id);
      run('INSERT INTO ticket_time (ticket_id, user_id, started_at) VALUES (?,?,?)', ticket_id, actor.id, now());
    } else if (running && running.ticket_id === Number(ticket_id)) stopTimerRow(running.id);
    return getTicket(ticket_id);
  });
}
function addManualTime({ ticket_id, minutes, user_id }, actor) {
  const m = Number(minutes);
  if (!(m > 0)) throw new AppError('minutes must be greater than zero');
  const uid = int(user_id) || actor?.id;
  if (!uid) throw new AppError('user_id is required');
  if (!get('SELECT 1 FROM tickets WHERE id = ?', ticket_id)) throw notFound('Ticket');
  if (!get('SELECT 1 FROM users WHERE id = ?', uid)) throw new AppError('Unknown technician');
  if (m > 24 * 60) throw new AppError('That is more than 24 hours — split it into separate entries');
  const end = now();
  run('INSERT INTO ticket_time (ticket_id, user_id, started_at, stopped_at, minutes) VALUES (?,?,?,?,?)', ticket_id, uid, new Date(Date.parse(end) - m * 60000).toISOString(), end, m);
  return getTicket(ticket_id);
}
function runningTimer(user) {
  if (!user?.id) return null;
  return get('SELECT tt.ticket_id, tt.started_at, t.number FROM ticket_time tt JOIN tickets t ON t.id = tt.ticket_id WHERE tt.user_id = ? AND tt.stopped_at IS NULL', user.id) || null;
}

function publicTicket(code) {
  const t = get('SELECT id FROM tickets WHERE tracking_code = ?', String(code || ''));
  if (!t) throw notFound('Ticket');
  const full = getTicket(t.id);
  const s = getSettings();
  return {
    number: full.number, status: full.status, statuses: s.ticket_statuses.filter((x) => x !== 'Cancelled'),
    device: [full.brand, full.model].filter(Boolean).join(' ') || full.device_type, issue: full.issue,
    estimate: full.estimate, due_date: full.due_date, created_at: full.created_at, updated_at: full.updated_at,
    updates: full.notes.filter((n) => n.type === 'diagnostic').map((n) => ({ body: n.body, at: n.created_at })),
    currency: s.currency,
    store: { name: s.store_name, phone: s.store_phone, address: s.store_address, hours: s.store_hours },
  };
}

// ---------------------------------------------------------------- invoices / POS
function calcTotals(lines, discount, taxRate) {
  const subtotal = money(lines.reduce((a, l) => a + l.qty * l.unit_price, 0));
  const taxableBase = lines.reduce((a, l) => a + (l.taxable ? l.qty * l.unit_price : 0), 0);
  const d = Math.min(Math.max(0, money(discount)), subtotal);
  const taxable = Math.max(0, taxableBase - (subtotal ? d * (taxableBase / subtotal) : 0));
  const tax = money(taxable * (taxRate / 100));
  return { subtotal, discount: d, tax, total: money(subtotal - d + tax) };
}
function createInvoice({ customer_id = null, ticket_id = null, lines = [], discount = 0, notes = '', payments = [] }, actor) {
  const s = getSettings();
  return tx(() => {
    if (!Array.isArray(lines)) throw new AppError('lines must be a list');
    if (!Array.isArray(payments)) throw new AppError('payments must be a list');
    // Lines sent by a client are always retail lines: only the ticket's own parts may skip the stock deduction.
    const clientLines = lines.map((l) => ({ ...(l && typeof l === 'object' ? l : {}), from_ticket: false }));
    let finalLines = clientLines;
    if (ticket_id) {
      const t = getTicket(ticket_id);
      if (t.invoice_id) throw new AppError(`Ticket already invoiced (${get('SELECT number FROM invoices WHERE id = ?', t.invoice_id)?.number})`);
      ticket_id = t.id;
      customer_id = t.customer_id; // a ticket is always invoiced to its own customer (deposits and credit follow it)
      finalLines = [...t.items.map((i) => ({ item_id: i.item_id, description: i.description, qty: i.qty, unit_price: i.unit_price, unit_cost: i.unit_cost, taxable: i.taxable, from_ticket: true })), ...clientLines];
      if (!finalLines.length && t.estimate) finalLines = [{ description: `Repair ${t.number}: ${t.brand} ${t.model} – ${t.issue}`, qty: 1, unit_price: t.estimate, taxable: 1, from_ticket: true }];
    } else if (customer_id != null && customer_id !== '') {
      if (!get('SELECT 1 FROM customers WHERE id = ?', int(customer_id, -1))) throw notFound('Customer');
      customer_id = int(customer_id);
    } else customer_id = null;
    if (!finalLines.length) throw new AppError('Invoice needs at least one line');
    const norm = finalLines.map((l) => {
      const item = l.item_id ? get('SELECT * FROM items WHERE id = ?', l.item_id) : null;
      if (l.item_id && !item) throw notFound('Item');
      return {
        item_id: item?.id || null, description: String(l.description || item?.name || 'Item'), qty: l.from_ticket ? num(l.qty, 1) : posQty(l.qty ?? 1),
        unit_price: Math.max(0, money(l.unit_price ?? item?.price ?? 0)), unit_cost: Math.max(0, num(l.unit_cost ?? item?.cost ?? 0)),
        taxable: l.taxable ?? item?.taxable ?? 1 ? 1 : 0, from_ticket: !!l.from_ticket,
      };
    });
    const totals = calcTotals(norm, discount, Number(s.tax_rate) || 0);
    const number = nextNumber('invoices', s.invoice_prefix);
    const r = run('INSERT INTO invoices (number, customer_id, ticket_id, subtotal, discount, tax, total, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      number, customer_id, ticket_id, totals.subtotal, totals.discount, totals.tax, totals.total, notes, actor?.id || null);
    const id = Number(r.lastInsertRowid);
    for (const l of norm) {
      run('INSERT INTO invoice_lines (invoice_id, item_id, description, qty, unit_price, unit_cost, taxable, from_ticket) VALUES (?,?,?,?,?,?,?,?)',
        id, l.item_id, l.description, l.qty, l.unit_price, l.unit_cost, l.taxable, l.from_ticket ? 1 : 0);
      // Retail sales take stock now; ticket parts were already taken when attached to the repair.
      if (l.item_id && !l.from_ticket && get("SELECT 1 FROM items WHERE id = ? AND kind <> 'service'", l.item_id)) adjustStock({ item_id: l.item_id, qty: -l.qty, reason: 'Sale', ref: number }, actor);
    }
    if (ticket_id) {
      run('UPDATE tickets SET invoice_id = ? WHERE id = ?', id, ticket_id);
      addNote({ ticket_id, type: 'system', body: `Invoice ${number} created (${totals.total.toFixed(2)})` }, actor);
    }
    if (ticket_id) {
      // Deposits taken at check-in become payments on the invoice.
      for (const d of all('SELECT * FROM ticket_deposits WHERE ticket_id = ? AND invoice_id IS NULL', ticket_id)) {
        run('INSERT INTO payments (invoice_id, method, amount, reference, user_id, created_at, deposit_id) VALUES (?,?,?,?,?,?,?)', id, d.method, d.amount, `Deposit${d.reference ? ' – ' + d.reference : ''}`, d.user_id, d.created_at, d.id);
        run('UPDATE ticket_deposits SET invoice_id = ? WHERE id = ?', id, d.id);
      }
      syncPaid(id);
      // A deposit bigger than the bill: the difference goes to the customer's store credit.
      const over = money(get('SELECT paid - total AS o FROM invoices WHERE id = ?', id).o);
      if (over > 0 && customer_id) {
        run('UPDATE customers SET store_credit = store_credit + ? WHERE id = ?', over, customer_id);
        addNote({ ticket_id, type: 'system', body: `Deposit exceeded the invoice by ${over.toFixed(2)} — added to the customer's store credit` }, actor);
        audit(actor?.name, 'store_credit', { customer_id, amount: over, reason: `Excess deposit ${number}` });
      }
    }
    for (const p of payments) {
      const bal = money(get('SELECT total - paid AS b FROM invoices WHERE id = ?', id).b);
      if (bal <= 0 && p.amount == null) continue; // already covered (e.g. by a deposit)
      recordPayment({ invoice_id: id, ...p }, actor);
    }
    audit(actor?.name, 'invoice.create', number);
    const inv = getInvoice(id);
    emit('invoice.created', inv);
    return inv;
  });
}
function getInvoice(idOrNumber) {
  const inv = get(`SELECT i.*, c.first_name || ' ' || c.last_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
                          c.address AS customer_address, t.number AS ticket_number, t.warranty_days
                   FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id LEFT JOIN tickets t ON t.id = i.ticket_id
                   WHERE i.id = ? OR i.number = ?`, Number(idOrNumber) || -1, String(idOrNumber));
  if (!inv) throw notFound('Invoice');
  inv.lines = all('SELECT * FROM invoice_lines WHERE invoice_id = ?', inv.id);
  inv.payments = all('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id', inv.id);
  inv.balance = Math.max(0, money(inv.total - inv.paid));
  inv.overpaid = Math.max(0, money(inv.paid - inv.total));
  return inv;
}
function listInvoices({ q = '', status = '', from = '', to = '', limit = 200 } = {}) {
  const like = `%${q}%`;
  from = isDate(dateOnly(from)) ? dateOnly(from) : ''; to = isDate(dateOnly(to)) ? dateOnly(to) : '';
  return all(`SELECT i.id, i.number, i.status, i.total, i.paid, i.created_at, i.ticket_id,
                     c.first_name || ' ' || c.last_name AS customer_name
              FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
              WHERE (? = '' OR i.number LIKE ? OR c.first_name || ' ' || c.last_name LIKE ?)
                AND (? = '' OR i.status = ?) AND (? = '' OR ${localDay('i.created_at')} >= ?) AND (? = '' OR ${localDay('i.created_at')} <= ?)
              ORDER BY i.id DESC LIMIT ?`, q, like, like, status, status, from, from, to, to, lim(limit, 200));
}
function syncPaid(invoiceId) {
  const inv = get('SELECT total FROM invoices WHERE id = ?', invoiceId);
  const paid = money(get('SELECT COALESCE(SUM(amount),0) AS p FROM payments WHERE invoice_id = ?', invoiceId).p);
  run("UPDATE invoices SET paid = ?, status = CASE WHEN status = 'void' THEN 'void' WHEN ? >= total THEN 'paid' WHEN ? > 0 THEN 'partial' ELSE 'unpaid' END WHERE id = ?", paid, paid, paid, invoiceId);
  return inv;
}
function recordPayment({ invoice_id, method = 'cash', amount, reference = '' }, actor) {
  return tx(() => {
    const inv = getInvoice(invoice_id);
    if (inv.status === 'void') throw new AppError('Invoice is void');
    if (!['cash', 'card', 'transfer', 'store_credit', 'other'].includes(method)) throw new AppError('method must be cash, card, transfer, store_credit or other');
    const amt = money(amount ?? inv.balance);
    if (!(amt > 0)) throw new AppError('Payment amount must be greater than zero');
    if (amt > inv.balance + 0.004) throw new AppError(`Amount is more than the balance due (${inv.balance.toFixed(2)})`);
    if (method === 'store_credit') {
      if (!inv.customer_id) throw new AppError('Attach a customer to use store credit');
      const c = get('SELECT store_credit FROM customers WHERE id = ?', inv.customer_id);
      if (!c || c.store_credit < amt - 0.004) throw new AppError('Not enough store credit');
      run('UPDATE customers SET store_credit = store_credit - ? WHERE id = ?', amt, inv.customer_id);
    }
    run('INSERT INTO payments (invoice_id, method, amount, reference, user_id) VALUES (?,?,?,?,?)', inv.id, method, amt, String(reference || ''), actor?.id || null);
    syncPaid(inv.id);
    const after = getInvoice(inv.id);
    if (after.status === 'paid') emit('invoice.paid', { number: after.number, total: after.total, customer: after.customer_name });
    return after;
  });
}
function voidInvoice(id, actor) {
  return tx(() => {
    const inv = getInvoice(id);
    if (inv.status === 'void') return inv;
    // If an excess deposit became store credit and the customer has already spent it, voiding would hand the credit out twice.
    if (inv.ticket_id && inv.customer_id && inv.payments.some((p) => p.deposit_id)) {
      const deposits = money(inv.payments.filter((p) => p.deposit_id).reduce((a, p) => a + p.amount, 0));
      const granted = money(deposits - inv.total);
      const bal = get('SELECT store_credit FROM customers WHERE id = ?', inv.customer_id)?.store_credit || 0;
      if (granted > 0 && bal < granted - 0.004) throw new AppError(`Can't void: ${granted.toFixed(2)} of this ticket's deposit became store credit and the customer has already used ${money(granted - bal).toFixed(2)} of it. Void the invoice that used the credit first, or adjust the customer's store credit.`);
    }
    // Return stock for retail lines (parts copied from a ticket stay on the ticket).
    for (const l of inv.lines) {
      if (l.item_id && !l.from_ticket && get("SELECT 1 FROM items WHERE id = ? AND kind <> 'service'", l.item_id)) adjustStock({ item_id: l.item_id, qty: l.qty, reason: 'Void', ref: inv.number }, actor);
    }
    // Store credit spent on this invoice goes back to the customer.
    const credit = money(inv.payments.filter((p) => p.method === 'store_credit').reduce((a, p) => a + p.amount, 0));
    if (credit > 0 && inv.customer_id) run('UPDATE customers SET store_credit = store_credit + ? WHERE id = ?', credit, inv.customer_id);
    run("UPDATE invoices SET status = 'void' WHERE id = ?", inv.id);
    if (inv.ticket_id) {
      run('UPDATE tickets SET invoice_id = NULL WHERE id = ?', inv.ticket_id);
      // Deposits go back onto the ticket so they apply to the replacement invoice.
      run('DELETE FROM payments WHERE invoice_id = ? AND deposit_id IS NOT NULL', inv.id);
      run('UPDATE ticket_deposits SET invoice_id = NULL WHERE invoice_id = ?', inv.id);
      // Excess deposit that became store credit is taken back, since the deposit returns to the ticket.
      const excess = money(get('SELECT COALESCE(SUM(amount),0) AS a FROM ticket_deposits WHERE ticket_id = ? AND invoice_id IS NULL', inv.ticket_id).a - inv.total);
      if (excess > 0 && inv.customer_id && inv.payments.some((p) => p.deposit_id)) run('UPDATE customers SET store_credit = MAX(0, store_credit - ?) WHERE id = ?', excess, inv.customer_id);
      syncPaid(inv.id);
    }
    const refundDue = money(inv.payments.filter((p) => !p.deposit_id && p.method !== 'store_credit').reduce((a, p) => a + p.amount, 0));
    if (refundDue > 0) audit(actor?.name, 'invoice.void.refund_due', { invoice: inv.number, amount: refundDue });
    if (inv.ticket_id) addNote({ ticket_id: inv.ticket_id, type: 'system', body: `Invoice ${inv.number} voided${credit ? `; ${credit.toFixed(2)} store credit returned` : ''}${refundDue ? `; ${refundDue.toFixed(2)} paid by cash/card — refund the customer or take it on the new invoice` : ''}` }, actor);
    emit('invoice.voided', { number: inv.number });
    audit(actor?.name, 'invoice.void', inv.number);
    return getInvoice(inv.id);
  });
}
function addStoreCredit({ customer_id, amount, reason = '' }, actor) {
  const amt = money(amount);
  if (!amt) throw new AppError('Amount must be a non-zero number');
  const c = get('SELECT store_credit FROM customers WHERE id = ?', customer_id);
  if (!c) throw notFound('Customer');
  if (c.store_credit + amt < -0.004) throw new AppError('Store credit cannot go below zero');
  run('UPDATE customers SET store_credit = store_credit + ? WHERE id = ?', amt, customer_id);
  audit(actor?.name, 'store_credit', { customer_id, amount: amt, reason });
  return getCustomer(customer_id);
}

// ---------------------------------------------------------------- purchase orders
function listPOs() {
  return all(`SELECT p.*, (SELECT SUM(qty * unit_cost) FROM po_lines WHERE po_id = p.id) AS total,
                     (SELECT COUNT(*) FROM po_lines WHERE po_id = p.id) AS line_count
              FROM purchase_orders p ORDER BY id DESC`);
}
function getPO(id) {
  const po = get('SELECT * FROM purchase_orders WHERE id = ?', id);
  if (!po) throw notFound('Purchase order');
  po.lines = all(`SELECT l.*, i.name, i.sku, i.supplier_sku, i.stock FROM po_lines l JOIN items i ON i.id = l.item_id WHERE po_id = ?`, id);
  po.total = money(po.lines.reduce((a, l) => a + l.qty * l.unit_cost, 0));
  return po;
}
function createPO({ supplier, notes = '', lines = [] }) {
  supplier = supplier ?? defaultSupplier();
  const s = getSettings();
  return tx(() => {
    const r = run('INSERT INTO purchase_orders (number, supplier, notes) VALUES (?, ?, ?)', nextNumber('purchase_orders', s.po_prefix), supplier, notes);
    const id = Number(r.lastInsertRowid);
    for (const l of lines) {
      const item = get('SELECT cost FROM items WHERE id = ?', l.item_id);
      if (!item) throw notFound('Item');
      run('INSERT INTO po_lines (po_id, item_id, qty, unit_cost) VALUES (?,?,?,?)', id, l.item_id, posQty(l.qty ?? 1), Math.max(0, num(l.unit_cost ?? item.cost)));
    }
    return getPO(id);
  });
}
function setPOStatus(id, status) {
  if (!['draft', 'ordered', 'cancelled'].includes(status)) throw new AppError('Use receivePO to receive');
  const po = getPO(id);
  if (['received', 'partial'].includes(po.status)) throw new AppError('This purchase order has already been (partly) received');
  run('UPDATE purchase_orders SET status = ? WHERE id = ?', status, id);
  return getPO(id);
}
function receivePO({ po_id, lines }, actor) {
  // lines: [{line_id, qty}] — omitted means "receive everything outstanding" (GRN)
  return tx(() => {
    const po = getPO(po_id);
    if (po.status === 'cancelled') throw new AppError('This purchase order is cancelled');
    if (po.status === 'received') throw new AppError('This purchase order is already fully received');
    const todo = lines?.length ? lines : po.lines.map((l) => ({ line_id: l.id, qty: l.qty - l.received_qty }));
    for (const { line_id, qty: rawQty } of todo) {
      const l = po.lines.find((x) => x.id === Number(line_id));
      if (!l) throw new AppError(`Line ${line_id} is not on this purchase order`);
      const qty = num(rawQty);
      if (qty === 0) continue;
      if (qty < 0) throw new AppError('Received quantity cannot be negative');
      run('UPDATE po_lines SET received_qty = received_qty + ? WHERE id = ?', qty, line_id);
      adjustStock({ item_id: l.item_id, qty, reason: 'PO received', ref: po.number }, actor);
      if (l.unit_cost) run('UPDATE items SET cost = ? WHERE id = ?', l.unit_cost, l.item_id);
    }
    const after = getPO(po_id);
    const full = after.lines.every((l) => l.received_qty >= l.qty);
    run('UPDATE purchase_orders SET status = ?, received_at = ? WHERE id = ?', full ? 'received' : 'partial', full ? now() : null, po_id);
    return getPO(po_id);
  });
}

// ---------------------------------------------------------------- reorder helper (Parts4Cells links only when enabled)
const defaultSupplier = () => (getSettings().p4c_enabled ? 'Parts4Cells' : '');
function partsOrderList() {
  const s = getSettings();
  const low = searchItems({ low: true, limit: 500 });
  const tpl = s.p4c_enabled ? (s.p4c_search_url || DEFAULT_SETTINGS.p4c_search_url) : '';
  return low.map((i) => {
    const qty = Math.max(1, Math.ceil((i.min_stock || 1) * 2 - i.stock));
    const query = i.supplier_sku || i.name;
    return {
      item_id: i.id, name: i.name, sku: i.sku, supplier_sku: i.supplier_sku, stock: i.stock, min_stock: i.min_stock,
      suggested_qty: qty, supplier: i.supplier || '', ...(tpl ? { parts4cells_url: tpl.replace('{query}', encodeURIComponent(query)) } : {}),
    };
  });
}

// ---------------------------------------------------------------- appointments
function listAppointments({ from = '', to = '' } = {}) {
  return all(`SELECT a.*, COALESCE(c.first_name || ' ' || c.last_name, a.name) AS customer_name, COALESCE(c.phone, a.phone) AS customer_phone
              FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
              WHERE (? = '' OR date(a.starts_at) >= ?) AND (? = '' OR date(a.starts_at) <= ?) AND a.status <> 'cancelled'
              ORDER BY a.starts_at`, dateOnly(from), dateOnly(from), dateOnly(to), dateOnly(to));
}
function bookAppointment({ customer_id = null, name = '', phone = '', starts_at, minutes = 30, title = '', notes = '', source = 'staff' }, actor) {
  if (!starts_at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(starts_at)) throw new AppError('starts_at is required as local date-time, e.g. 2026-11-05T14:30');
  starts_at = String(starts_at).slice(0, 16);
  minutes = Math.max(5, int(minutes, 30));
  if (!customer_id && phone) customer_id = get("SELECT id FROM customers WHERE replace(phone,'-','') = replace(?,'-','')", phone)?.id || null;
  const r = run('INSERT INTO appointments (customer_id, name, phone, starts_at, minutes, title, notes, source) VALUES (?,?,?,?,?,?,?,?)',
    customer_id, name, phone, starts_at, minutes, title, notes, source);
  audit(actor?.name, 'appointment.book', starts_at);
  const appt = get('SELECT * FROM appointments WHERE id = ?', Number(r.lastInsertRowid));
  emit('appointment.booked', appt);
  return appt;
}
function updateAppointment(id, data) {
  if ('status' in data && !['booked', 'done', 'cancelled', 'no_show'].includes(data.status)) throw new AppError('status must be booked, done, cancelled or no_show');
  if ('starts_at' in data && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(data.starts_at)) throw new AppError('starts_at must look like 2026-11-05T14:30');
  if ('minutes' in data) data.minutes = Math.max(5, int(data.minutes, 30));
  if (!get('SELECT 1 FROM appointments WHERE id = ?', id)) throw notFound('Appointment');
  const f = ['starts_at', 'minutes', 'title', 'notes', 'status'].filter((k) => k in data);
  if (f.length) run(`UPDATE appointments SET ${f.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...f.map((k) => data[k]), id);
  return get('SELECT * FROM appointments WHERE id = ?', id);
}

// ---------------------------------------------------------------- time clock
function clock(user, action) {
  const open = get('SELECT * FROM time_clock WHERE user_id = ? AND clock_out IS NULL', user.id);
  if (action === 'in') { if (!open) run('INSERT INTO time_clock (user_id, clock_in) VALUES (?, ?)', user.id, now()); }
  else if (open) run('UPDATE time_clock SET clock_out = ? WHERE id = ?', now(), open.id);
  return clockStatus(user);
}
function clockStatus(user) {
  return { clocked_in: !!get('SELECT 1 FROM time_clock WHERE user_id = ? AND clock_out IS NULL', user.id), running_timer: runningTimer(user) };
}

// ---------------------------------------------------------------- reports
// All dates are the shop's local calendar days (Settings → Store → Time zone).
function report({ from, to } = {}) {
  const s = getSettings();
  const today = localToday();
  let f = dateOnly(from); let t = dateOnly(to);
  if (!isDate(t)) t = today;
  if (!isDate(f)) f = new Date(Date.parse(t) - 29 * 864e5).toISOString().slice(0, 10);
  if (f > t) [f, t] = [t, f];
  const day = localDay;
  const inv = `status <> 'void' AND ${day('created_at')} BETWEEN ? AND ?`;
  const sales = get(`SELECT COUNT(*) AS invoices, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(tax),0) AS tax,
                            COALESCE(SUM(MAX(total - paid, 0)),0) AS outstanding FROM invoices WHERE ${inv}`, f, t);
  const cogs = get(`SELECT COALESCE(SUM(l.qty * l.unit_cost),0) AS cogs FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
                    WHERE i.status <> 'void' AND ${day('i.created_at')} BETWEEN ? AND ?`, f, t).cogs;
  return {
    from: f, to: t, currency: s.currency, timezone: s.timezone,
    sales: { ...sales, revenue: money(sales.revenue), tax: money(sales.tax), outstanding: money(sales.outstanding), cogs: money(cogs), gross_profit: money(sales.revenue - sales.tax - cogs) },
    daily: all(`SELECT ${day('created_at')} AS day, ROUND(SUM(total),2) AS revenue, COUNT(*) AS invoices FROM invoices WHERE ${inv} GROUP BY day ORDER BY day`, f, t),
    payments_by_method: all(`SELECT method, ROUND(SUM(amount),2) AS amount FROM (
        SELECT p.method, p.amount, p.created_at FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.status <> 'void'
        UNION ALL SELECT method, amount, created_at FROM ticket_deposits WHERE invoice_id IS NULL)
      WHERE ${day('created_at')} BETWEEN ? AND ? GROUP BY method`, f, t),
    deposits_held: money(get('SELECT COALESCE(SUM(amount),0) AS v FROM ticket_deposits WHERE invoice_id IS NULL').v),
    tickets_created: get(`SELECT COUNT(*) AS n FROM tickets WHERE ${day('created_at')} BETWEEN ? AND ?`, f, t).n,
    tickets_closed: get(`SELECT COUNT(*) AS n FROM tickets WHERE closed_at IS NOT NULL AND ${day('closed_at')} BETWEEN ? AND ?`, f, t).n,
    tickets_by_status: all(`SELECT status, COUNT(*) AS n FROM tickets GROUP BY status`),
    top_repairs: all(`SELECT TRIM(brand || ' ' || model) AS device, COUNT(*) AS n FROM tickets WHERE ${day('created_at')} BETWEEN ? AND ? AND model <> '' GROUP BY device ORDER BY n DESC LIMIT 10`, f, t),
    top_items: all(`SELECT COALESCE(it.name, l.description) AS description, SUM(l.qty) AS qty, ROUND(SUM(l.qty*l.unit_price),2) AS revenue
                    FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id LEFT JOIN items it ON it.id = l.item_id
                    WHERE i.status <> 'void' AND ${day('i.created_at')} BETWEEN ? AND ?
                    GROUP BY COALESCE('item:' || l.item_id, 'text:' || l.description) ORDER BY revenue DESC LIMIT 10`, f, t),
    by_repair_type: byRepairType(f, t),
    by_technician: byTechnician(f, t, s),
    low_stock: searchItems({ low: true, limit: 20 }).length,
    inventory_value: money(get("SELECT COALESCE(SUM(MAX(stock,0) * cost),0) AS v FROM items WHERE active = 1 AND kind <> 'service'").v),
  };
}

// Revenue/cost per invoiced repair. Revenue is before tax, after discount.
const repairRows = () => `SELECT t.id AS ticket_id, t.repair_type, t.assigned_to, i.subtotal - i.discount AS revenue,
       (SELECT COALESCE(SUM(qty * unit_cost),0) FROM invoice_lines WHERE invoice_id = i.id) AS cost
  FROM invoices i JOIN tickets t ON t.id = i.ticket_id
  WHERE i.status <> 'void' AND ${localDay('i.created_at')} BETWEEN ? AND ?`;
function byRepairType(f, t) {
  return all(`SELECT COALESCE(NULLIF(repair_type,''),'Unspecified') AS repair_type, COUNT(*) AS jobs,
                     ROUND(SUM(revenue),2) AS revenue, ROUND(SUM(cost),2) AS cost, ROUND(SUM(revenue - cost),2) AS profit,
                     ROUND(SUM(revenue - cost) / COUNT(*), 2) AS profit_per_job,
                     CASE WHEN SUM(revenue) > 0 THEN ROUND(100.0 * SUM(revenue - cost) / SUM(revenue), 1) ELSE 0 END AS margin_pct
              FROM (${repairRows()}) GROUP BY 1 ORDER BY profit DESC`, f, t);
}
function byTechnician(f, t, s) {
  const basis = s.commission_basis === 'revenue' ? 'revenue' : 'profit';
  return all(`SELECT u.id, u.name AS tech, u.commission_rate,
        (SELECT COUNT(*) FROM tickets x WHERE x.assigned_to = u.id AND x.closed_at IS NOT NULL AND ${localDay('x.closed_at')} BETWEEN ? AND ?) AS closed,
        (SELECT ROUND(COALESCE(SUM(minutes),0)/60.0, 1) FROM ticket_time tt WHERE tt.user_id = u.id AND tt.stopped_at IS NOT NULL AND ${localDay('tt.started_at')} BETWEEN ? AND ?) AS hours,
        COALESCE(r.jobs,0) AS invoiced_jobs, ROUND(COALESCE(r.revenue,0),2) AS revenue, ROUND(COALESCE(r.profit,0),2) AS profit
      FROM users u LEFT JOIN (SELECT assigned_to, COUNT(*) AS jobs, SUM(revenue) AS revenue, SUM(revenue - cost) AS profit FROM (${repairRows()}) GROUP BY assigned_to) r ON r.assigned_to = u.id
      WHERE u.active = 1 ORDER BY revenue DESC, closed DESC`, f, t, f, t, f, t)
    .map((x) => ({ ...x, commission_basis: basis, commission: money((Math.max(0, x[basis]) * (x.commission_rate || 0)) / 100) }));
}

function dashboard() {
  const s = getSettings();
  const today = localToday();
  const open = listTickets({ open: true, limit: 1000 });
  return {
    today,
    open_tickets: open.length,
    overdue: open.filter((t) => t.overdue).length,
    ready_for_pickup: open.filter((t) => t.status === 'Ready for pickup').length,
    today_revenue: money(get(`SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE status <> 'void' AND ${localDay('created_at')} = ?`, today).v),
    today_appointments: listAppointments({ from: today, to: today }),
    low_stock: searchItems({ low: true, limit: 50 }),
    by_status: s.ticket_statuses.map((st) => ({ status: st, n: open.filter((t) => t.status === st).length })).filter((x) => x.n),
    recent: open.slice(0, 8),
  };
}

module.exports = {
  friendlyError, importItems,
  AppError, getSettings, updateSettings, DEFAULT_SETTINGS, audit,
  searchCustomers, getCustomer, saveCustomer, addStoreCredit,
  searchItems, getItem, saveItem, deleteItem, adjustStock, stockCount, addSerials,
  listPrices, savePrice, deletePrice, quoteRepair,
  listTickets, getTicket, createTicket, updateTicket, setTicketStatus, addNote, addTicketItem, removeTicketItem, publicTicket,
  addDeposit, removeDeposit, ticketTimer, addManualTime, runningTimer, emit, WEBHOOK_EVENTS,
  createInvoice, getInvoice, listInvoices, recordPayment, voidInvoice,
  listPOs, getPO, createPO, setPOStatus, receivePO, partsOrderList,
  listAppointments, bookAppointment, updateAppointment, clock, clockStatus,
  report, dashboard, localToday, defaultSupplier,
};
