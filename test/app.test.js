// End-to-end tests: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Runs against a fresh Node server by default, or against any running instance with TEST_URL
// (e.g. `npx wrangler dev --persist-to /tmp/x` then `TEST_URL=http://localhost:8787 npm test`).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orp-test-'));
const app = process.env.TEST_URL ? null : require('../server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

let base; let server; let cookie = '';
const call = async (method, url, body, headers = {}) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json() };
};

test.before(async () => {
  if (!app) { base = process.env.TEST_URL.replace(/\/$/, ''); return; }
  server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

test('setup, tickets, inventory, invoices, MCP', async (t) => {
  let r = await call('GET', '/api/status');
  assert.equal(r.body.setup_required, true);
  r = await call('POST', '/api/setup', { name: 'Owner', email: 'o@x.com', password: 'password123', store_name: 'Test Shop' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  cookie = ''; // sign in again to exercise the login path
  r = await call('POST', '/api/login', { email: 'o@x.com', password: 'password123' });
  assert.equal(r.status, 200);
  assert.equal((await call('POST', '/api/setup', { name: 'X', email: 'x@x.com', password: 'password123' })).status, 403);

  const part = (await call('POST', '/api/items', { name: 'iPhone 13 Screen', cost: 50, price: 120, stock: 3, min_stock: 2 })).body;
  assert.equal(part.stock, 3);
  const cust = (await call('POST', '/api/customers', { first_name: 'Ana', phone: '713-555-0100' })).body;
  const tk = (await call('POST', '/api/tickets', { customer_id: cust.id, brand: 'Apple', model: 'iPhone 13', issue: 'cracked' })).body;
  assert.match(tk.number, /^T-\d+/);

  await t.test('attaching a part reserves stock and shows low stock', async () => {
    await call('POST', `/api/tickets/${tk.id}/items`, { item_id: part.id });
    await call('POST', `/api/tickets/${tk.id}/items`, { description: 'Labor', unit_price: 40 });
    const low = (await call('GET', '/api/items?low=1')).body;
    assert.equal(low.length, 1);
    assert.equal(low[0].stock, 2);
  });

  await t.test('status change + public tracking hides internal notes', async () => {
    await call('POST', `/api/tickets/${tk.id}/notes`, { type: 'internal', body: 'secret' });
    await call('POST', `/api/tickets/${tk.id}/notes`, { type: 'diagnostic', body: 'Screen replaced' });
    await call('PUT', `/api/tickets/${tk.id}`, { status: 'Ready for pickup' });
    const pub = (await call('GET', `/api/track/${tk.tracking_code}`, null, { cookie: '' })).body;
    assert.equal(pub.status, 'Ready for pickup');
    assert.deepEqual(pub.updates.map((u) => u.body), ['Screen replaced']);
    assert.ok(!JSON.stringify(pub).includes('secret'));
  });

  await t.test('invoice from ticket does not double-deduct stock; payment marks paid', async () => {
    const inv = (await call('POST', `/api/tickets/${tk.id}/invoice`)).body;
    assert.equal(inv.subtotal, 160);
    assert.equal((await call('GET', `/api/items/${part.id}`)).body.stock, 2);
    const paid = (await call('POST', `/api/invoices/${inv.id}/payments`, { method: 'card', amount: inv.total })).body;
    assert.equal(paid.status, 'paid');
    assert.equal((await call('POST', `/api/tickets/${tk.id}/invoice`)).status, 400);
  });

  await t.test('retail sale deducts stock, void returns it', async () => {
    const inv = (await call('POST', '/api/invoices', { lines: [{ item_id: part.id, qty: 1 }] })).body;
    assert.equal((await call('GET', `/api/items/${part.id}`)).body.stock, 1);
    await call('POST', `/api/invoices/${inv.id}/void`);
    assert.equal((await call('GET', `/api/items/${part.id}`)).body.stock, 2);
  });

  await t.test('purchase order receive adds stock', async () => {
    const po = (await call('POST', '/api/purchase-orders', { supplier: 'Parts4Cells', lines: [{ item_id: part.id, qty: 5 }] })).body;
    const rec = (await call('POST', `/api/purchase-orders/${po.id}/receive`, {})).body;
    assert.equal(rec.status, 'received');
    assert.equal((await call('GET', `/api/items/${part.id}`)).body.stock, 7);
  });

  await t.test('deposits apply to the invoice; repair-type profit, job time and commission show in reports', async () => {
    await call('PUT', '/api/settings', { ticket_custom_fields: ['VIN'], commission_basis: 'profit' });
    const me = (await call('GET', '/api/me')).body;
    await call('PUT', `/api/users/${me.id}`, { commission_rate: 10 });
    const tk2 = (await call('POST', '/api/tickets', { customer_id: cust.id, brand: 'Apple', model: 'iPhone 13', issue: 'battery', repair_type: 'Battery replacement', custom: { VIN: 'ABC123' }, assigned_to: me.id, deposit: { amount: 20, method: 'cash' } })).body;
    assert.equal(tk2.deposit_total, 20);
    assert.equal(tk2.custom.VIN, 'ABC123');
    await call('POST', `/api/tickets/${tk2.id}/items`, { item_id: part.id });           // part cost 50
    await call('POST', `/api/tickets/${tk2.id}/items`, { description: 'Labor', unit_price: 30 });
    await call('POST', `/api/tickets/${tk2.id}/timer/start`);
    assert.ok((await call('GET', '/api/me')).body.running_timer);
    await call('POST', `/api/tickets/${tk2.id}/timer/stop`);
    await call('POST', `/api/tickets/${tk2.id}/time`, { minutes: 90 });
    const inv = (await call('POST', `/api/tickets/${tk2.id}/invoice`)).body;
    assert.equal(inv.paid, 20);
    assert.equal(inv.status, 'partial');
    assert.equal((await call('POST', `/api/tickets/${tk2.id}/deposits`, { amount: 5 })).status, 400); // invoiced → no more deposits
    // voiding returns the deposit to the ticket; re-invoicing applies it again
    await call('POST', `/api/invoices/${inv.id}/void`);
    assert.equal((await call('GET', `/api/tickets/${tk2.id}`)).body.deposit_total, 20);
    const inv2 = (await call('POST', `/api/tickets/${tk2.id}/invoice`)).body;
    assert.equal(inv2.paid, 20);
    await call('PUT', `/api/tickets/${tk2.id}`, { status: 'Completed' });
    const rep = (await call('GET', '/api/reports')).body;
    const bt = rep.by_repair_type.find((x) => x.repair_type === 'Battery replacement');
    assert.equal(bt.jobs, 1); assert.equal(bt.revenue, 150); assert.equal(bt.cost, 50); assert.equal(bt.profit, 100);
    const tech = rep.by_technician.find((x) => x.id === me.id);
    assert.ok(tech.hours >= 1.5);
    assert.equal(tech.commission, 10); // 10% of 100 profit
  });

  await t.test('webhooks validate URLs', async () => {
    assert.equal((await call('PUT', '/api/settings', { webhooks: [{ url: 'http://insecure.example' }] })).status, 400);
    const ok = await call('PUT', '/api/settings', { webhooks: [{ url: 'https://example.com/hook', events: ['ticket.created', 'bogus'] }] });
    assert.deepEqual(ok.body.webhooks, [{ url: 'https://example.com/hook', events: ['ticket.created'] }]);
    await call('PUT', '/api/settings', { webhooks: [] });
  });

  await t.test('regressions from the pre-release review', async () => {
    // payments: no negatives, no overpaying, store credit can't be overspent and is refunded on void
    const c2 = (await call('POST', '/api/customers', { first_name: 'Credit' })).body;
    await call('POST', `/api/customers/${c2.id}/store-credit`, { amount: 100 });
    const sale = (await call('POST', '/api/invoices', { customer_id: c2.id, lines: [{ description: 'Case', unit_price: 10, taxable: 0 }] })).body;
    assert.equal((await call('POST', `/api/invoices/${sale.id}/payments`, { method: 'store_credit', amount: -500 })).status, 400);
    assert.equal((await call('POST', `/api/invoices/${sale.id}/payments`, { method: 'store_credit', amount: 100 })).status, 400);
    await call('POST', `/api/invoices/${sale.id}/payments`, { method: 'store_credit', amount: 10 });
    assert.equal((await call('GET', `/api/customers/${c2.id}`)).body.store_credit, 90);
    await call('POST', `/api/invoices/${sale.id}/void`);
    assert.equal((await call('GET', `/api/customers/${c2.id}`)).body.store_credit, 100);
    // negative quantities and discounts are rejected / ignored
    assert.equal((await call('POST', '/api/invoices', { lines: [{ item_id: part.id, qty: -100 }] })).status, 400);
    const neg = (await call('POST', '/api/invoices', { lines: [{ description: 'X', unit_price: 100, taxable: 0 }], discount: -50 })).body;
    assert.equal(neg.total, 100);
    // extra retail line on a ticket invoice: stock comes back on void
    const tk3 = (await call('POST', '/api/tickets', { customer_id: cust.id, issue: 'x' })).body;
    const before = (await call('GET', `/api/items/${part.id}`)).body.stock;
    const ti = (await call('POST', `/api/tickets/${tk3.id}/invoice`, { lines: [{ item_id: part.id, qty: 2 }] })).body;
    assert.equal((await call('GET', `/api/items/${part.id}`)).body.stock, before - 2);
    // invoiced tickets are locked
    assert.equal((await call('POST', `/api/tickets/${tk3.id}/items`, { item_id: part.id })).status, 400);
    await call('POST', `/api/invoices/${ti.id}/void`);
    assert.equal((await call('GET', `/api/items/${part.id}`)).body.stock, before);
    // numeric fields can't carry HTML
    const tk4 = (await call('POST', '/api/tickets', { customer_id: cust.id, issue: 'x', warranty_days: '<img src=x onerror=alert(1)>' })).body;
    assert.equal(typeof tk4.warranty_days, 'number');
    // settings validation
    assert.equal((await call('PUT', '/api/settings', { ticket_statuses: [] })).status, 400);
    // blank stock count does not zero the stock
    const st = (await call('GET', `/api/items/${part.id}`)).body.stock;
    await call('POST', '/api/stock-count', { counts: [{ item_id: part.id, counted: '' }] });
    assert.equal((await call('GET', `/api/items/${part.id}`)).body.stock, st);
    // cross-site cookie write is blocked
    assert.equal((await call('POST', '/api/customers', { first_name: 'Evil' }, { origin: 'https://evil.example' })).status, 403);
    // forged forwarded host does not change the public URL
    await call('GET', '/health', null, { 'x-forwarded-host': 'evil.example' });
    assert.ok(!String((await call('GET', '/api/settings')).body.public_url).includes('evil'));
    // a bad % escape is a 400, not a crash
    assert.equal((await call('GET', '/api/tickets/%E0')).status, 400);
  });

  await t.test('Parts4Cells integration is always on and cannot be disabled', async () => {
    await call('POST', '/api/items', { name: 'Low part', cost: 5, price: 10, stock: 0, min_stock: 2 });
    await call('PUT', '/api/settings', { p4c_enabled: false, p4c_search_url: 'https://other.example/?q={query}' });
    const st = (await call('GET', '/api/settings')).body;
    assert.equal(st.p4c_enabled, true);
    assert.ok(st.p4c_search_url.startsWith('https://parts4cells.com/'));
    const list = (await call('GET', '/api/parts-order-list')).body;
    assert.ok(list.length && list.every((r) => r.parts4cells_url.startsWith('https://parts4cells.com/')));
  });

  await t.test('sign out ends the session', async () => {
    const saved = cookie;
    await call('POST', '/api/logout');
    cookie = saved;
    assert.equal((await call('GET', '/api/me')).status, 401);
    cookie = '';
    await call('POST', '/api/login', { email: 'o@x.com', password: 'password123' });
    assert.equal((await call('GET', '/api/me')).status, 200);
  });

  await t.test('MCP: rejects without key, works with key', async () => {
    const bad = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(bad.status, 401);
    const key = (await call('POST', '/api/api-keys', { name: 'test' })).body.key;
    // API key also works on REST
    assert.equal((await call('GET', '/api/tickets', null, { cookie: '', authorization: `Bearer ${key}` })).status, 200);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${key}`)));
    const tools = (await client.listTools()).tools.map((x) => x.name);
    for (const n of ['search', 'fetch', 'create_ticket', 'quote_repair', 'parts_reorder_list', 'book_appointment', 'record_deposit', 'log_repair_time']) assert.ok(tools.includes(n), n);
    const res = await client.callTool({ name: 'list_tickets', arguments: { open_only: false } });
    assert.ok(res.content[0].text.includes(tk.number));
    const made = await client.callTool({ name: 'create_ticket', arguments: { new_customer: { first_name: 'Bo', phone: '1' }, issue: 'battery', brand: 'Samsung' } });
    assert.ok(!made.isError, made.content[0].text);
    const err = await client.callTool({ name: 'update_ticket_status', arguments: { ticket_id: tk.id, status: 'Nope' } });
    assert.ok(err.isError);
    await client.close();
  });

  await t.test('launch review fixes', async () => {
    const mkCust = async (n) => (await call('POST', '/api/customers', { first_name: n })).body;
    // 1. open tickets are found even when many closed tickets have older due dates
    const old = await mkCust('Old');
    for (let i = 0; i < 6; i++) {
      const x = (await call('POST', '/api/tickets', { customer_id: old.id, issue: 'old', due_date: '2020-01-0' + (i + 1) })).body;
      await call('PUT', `/api/tickets/${x.id}`, { status: 'Completed' });
    }
    const fresh = (await call('POST', '/api/tickets', { customer_id: old.id, issue: 'new', due_date: '2099-01-01' })).body;
    const openList = (await call('GET', '/api/tickets?open=1&limit=3')).body;
    assert.ok(openList.some((x) => x.id === fresh.id), 'open ticket missing from limited open list');
    assert.equal((await call('GET', '/api/customers?limit=abc')).status, 200);

    // 2 + 3. excess deposit credit goes to the ticket's own customer, and can't be handed out twice by a void
    const alice = await mkCust('Alice'); const bob = await mkCust('Bob');
    const tk3 = (await call('POST', '/api/tickets', { customer_id: alice.id, issue: 'x', deposit: { amount: 100, method: 'cash' } })).body;
    await call('POST', `/api/tickets/${tk3.id}/items`, { description: 'Labor', unit_price: 60, taxable: false });
    const inv3 = (await call('POST', `/api/tickets/${tk3.id}/invoice`, { customer_id: bob.id })).body;
    assert.equal(inv3.customer_id, alice.id);
    assert.equal((await call('GET', `/api/customers/${bob.id}`)).body.store_credit, 0);
    const credit = Math.round((100 - inv3.total) * 100) / 100;
    assert.ok(credit > 0);
    assert.equal((await call('GET', `/api/customers/${alice.id}`)).body.store_credit, credit);
    const spend = (await call('POST', '/api/invoices', { customer_id: alice.id, lines: [{ description: 'Case', unit_price: credit, taxable: false }], payments: [{ method: 'store_credit' }] })).body;
    assert.equal(spend.status, 'paid');
    const v = await call('POST', `/api/invoices/${inv3.id}/void`);
    assert.equal(v.status, 400, 'void must be blocked while the credit it created is spent');
    assert.equal((await call('GET', `/api/customers/${alice.id}`)).body.store_credit, 0);

    // 4. clients can't mark their own lines as ticket parts (skipping stock) or sell negative quantities
    const item = (await call('POST', '/api/items', { name: 'Charger', kind: 'product', price: 25, cost: 6, stock: 10 })).body;
    await call('POST', '/api/invoices', { lines: [{ item_id: item.id, qty: 3, from_ticket: true }] });
    assert.equal((await call('GET', `/api/items/${item.id}`)).body.stock, 7);
    assert.equal((await call('POST', '/api/invoices', { lines: [{ item_id: item.id, qty: -5, from_ticket: true }] })).status, 400);

    // 8. bad input gets a clear 400, not a server error
    assert.equal((await call('POST', '/api/appointments', { customer_id: 999999, starts_at: '2030-01-01T10:00' })).status, 400);
    assert.equal((await call('POST', '/api/stock-count', {})).status, 400);
    await call('POST', '/api/items', { name: 'A', sku: 'DUPE-1' });
    assert.equal((await call('POST', '/api/items', { name: 'B', sku: 'DUPE-1' })).status, 400);
    const imp = await call('POST', '/api/items/import', { items: [{ name: 'C', sku: 'NEW-1' }, { name: 'D', sku: 'DUPE-1' }] });
    assert.equal(imp.status, 400);
    assert.ok(!(await call('GET', '/api/items?q=NEW-1')).body.some((x) => x.sku === 'NEW-1'), 'import must be all-or-nothing');

    // 5. device passcodes never reach the AI assistant
    const pc = (await call('POST', '/api/tickets', { customer_id: alice.id, issue: 'screen', passcode: '482916' })).body;
    const key = (await call('POST', '/api/api-keys', { name: 'pc' })).body.key;
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${key}`)));
    for (const [name, args] of [['get_ticket', { ticket: pc.number }], ['fetch', { id: `ticket:${pc.id}` }], ['list_tickets', {}]]) {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!JSON.stringify(r).includes('482916'), `${name} leaked the passcode`);
    }
    await client.close();
  });
});
