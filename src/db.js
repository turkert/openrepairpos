// Database layer. The app talks to SQLite through a tiny "driver" so the same code runs:
//   • on Node.js (self-hosting / Docker)  → src/drivers/node.js  (node:sqlite)
//   • on Cloudflare (one-click deploy)    → src/worker.js        (Durable Object SQLite)
// A driver provides: all(sql, params), get(sql, params), run(sql, params) → {lastInsertRowid, changes},
// exec(sql) for multi-statement scripts, and transaction(fn).
let driver = null;
function setDriver(d) { driver = d; }
function need() { if (!driver) throw new Error('Database driver not set'); return driver; }

// SQLite can't bind undefined or booleans; normalise once here for every driver.
const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const all = (sql, ...p) => need().all(sql, norm(p));
const get = (sql, ...p) => need().get(sql, norm(p));
const run = (sql, ...p) => need().run(sql, norm(p));
const tx = (fn) => need().transaction(fn);

// Each migration runs once, in order. Add new ones at the end; never edit old ones.
const MIGRATIONS = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'tech', active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT);
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT DEFAULT '', phone TEXT DEFAULT '',
    email TEXT DEFAULT '', company TEXT DEFAULT '', address TEXT DEFAULT '', notes TEXT DEFAULT '',
    store_credit REAL NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE items (
    id INTEGER PRIMARY KEY, sku TEXT UNIQUE, name TEXT NOT NULL, category TEXT DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'part', cost REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0,
    stock REAL NOT NULL DEFAULT 0, min_stock REAL NOT NULL DEFAULT 0, supplier TEXT DEFAULT '',
    supplier_sku TEXT DEFAULT '', barcode TEXT DEFAULT '', taxable INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE serials (
    id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), serial TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_stock', ref TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE stock_moves (
    id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), qty REAL NOT NULL,
    reason TEXT NOT NULL, ref TEXT DEFAULT '', user_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE price_list (
    id INTEGER PRIMARY KEY, brand TEXT NOT NULL, model TEXT NOT NULL, repair TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0, item_id INTEGER REFERENCES items(id), minutes INTEGER DEFAULT 60,
    warranty_days INTEGER DEFAULT 90);
  CREATE TABLE tickets (
    id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(id),
    status TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', assigned_to INTEGER REFERENCES users(id),
    due_date TEXT, device_type TEXT DEFAULT '', brand TEXT DEFAULT '', model TEXT DEFAULT '',
    serial TEXT DEFAULT '', passcode TEXT DEFAULT '', issue TEXT DEFAULT '',
    pre_checklist TEXT DEFAULT '{}', post_checklist TEXT DEFAULT '{}', estimate REAL DEFAULT 0,
    warranty_days INTEGER DEFAULT 90, signature TEXT DEFAULT '', terms_accepted_at TEXT,
    tracking_code TEXT UNIQUE NOT NULL, invoice_id INTEGER, created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, closed_at TEXT);
  CREATE TABLE ticket_notes (
    id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), user_id INTEGER,
    type TEXT NOT NULL DEFAULT 'internal', body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE ticket_items (
    id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), item_id INTEGER REFERENCES items(id),
    description TEXT NOT NULL, qty REAL NOT NULL DEFAULT 1, unit_price REAL NOT NULL DEFAULT 0,
    unit_cost REAL NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'part', taxable INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE invoices (
    id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, customer_id INTEGER REFERENCES customers(id),
    ticket_id INTEGER REFERENCES tickets(id), status TEXT NOT NULL DEFAULT 'unpaid',
    subtotal REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0, paid REAL NOT NULL DEFAULT 0, notes TEXT DEFAULT '',
    created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE invoice_lines (
    id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), item_id INTEGER,
    description TEXT NOT NULL, qty REAL NOT NULL, unit_price REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0,
    taxable INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE payments (
    id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), method TEXT NOT NULL,
    amount REAL NOT NULL, reference TEXT DEFAULT '', user_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE purchase_orders (
    id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, supplier TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft', notes TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    received_at TEXT);
  CREATE TABLE po_lines (
    id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES purchase_orders(id), item_id INTEGER NOT NULL REFERENCES items(id),
    qty REAL NOT NULL, received_qty REAL NOT NULL DEFAULT 0, unit_cost REAL NOT NULL DEFAULT 0);
  CREATE TABLE appointments (
    id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), name TEXT DEFAULT '', phone TEXT DEFAULT '',
    starts_at TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 30, title TEXT NOT NULL DEFAULT '',
    notes TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'booked', source TEXT DEFAULT 'staff',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE time_clock (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), clock_in TEXT NOT NULL, clock_out TEXT);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY, actor TEXT, action TEXT NOT NULL, detail TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX idx_tickets_status ON tickets(status);
  CREATE INDEX idx_tickets_customer ON tickets(customer_id);
  CREATE INDEX idx_invoices_created ON invoices(created_at);
  CREATE INDEX idx_customers_phone ON customers(phone);
  `,
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  ALTER TABLE tickets ADD COLUMN repair_type TEXT NOT NULL DEFAULT '';
  ALTER TABLE tickets ADD COLUMN custom TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE users ADD COLUMN commission_rate REAL NOT NULL DEFAULT 0;
  CREATE TABLE ticket_deposits (
    id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), method TEXT NOT NULL, amount REAL NOT NULL,
    reference TEXT DEFAULT '', user_id INTEGER, invoice_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE ticket_time (
    id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), user_id INTEGER NOT NULL REFERENCES users(id),
    started_at TEXT NOT NULL, stopped_at TEXT, minutes REAL NOT NULL DEFAULT 0);
  CREATE INDEX idx_ticket_time_user ON ticket_time(user_id, stopped_at);
  CREATE INDEX idx_deposits_ticket ON ticket_deposits(ticket_id);
  `,
  `
  ALTER TABLE invoice_lines ADD COLUMN from_ticket INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payments ADD COLUMN deposit_id INTEGER;
  ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
  UPDATE invoice_lines SET from_ticket = 1 WHERE invoice_id IN (SELECT id FROM invoices WHERE ticket_id IS NOT NULL) AND description LIKE '%(' || (SELECT number FROM tickets WHERE tickets.id = (SELECT ticket_id FROM invoices WHERE invoices.id = invoice_lines.invoice_id)) || ')';
  UPDATE payments SET deposit_id = (SELECT d.id FROM ticket_deposits d WHERE d.invoice_id = payments.invoice_id AND d.amount = payments.amount AND d.method = payments.method LIMIT 1) WHERE reference LIKE 'Deposit%';
  `,
];

function migrate() {
  const d = need();
  d.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY)');
  const done = new Set(all('SELECT id FROM _migrations').map((r) => r.id));
  MIGRATIONS.forEach((sql, i) => {
    if (done.has(i + 1)) return;
    tx(() => {
      d.exec(sql);
      run('INSERT INTO _migrations (id) VALUES (?)', i + 1);
    });
  });
}

// Small key/value store for internal values that must never be exposed through settings.
function kvGet(key) { return get('SELECT value FROM kv WHERE key = ?', key)?.value; }
function kvSet(key, value) { run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }

module.exports = { setDriver, migrate, tx, all, get, run, kvGet, kvSet };
