// REST API used by the web app (cookie session) and by integrations (Authorization: Bearer orp_...).
// Framework-free: takes a standard Request, returns a standard Response — runs on Node.js and Cloudflare.
const S = require('./services');
const A = require('./auth');
const { seedDemo } = require('./seed');

const COOKIE = 'orp_session';
const rank = { tech: 1, manager: 2, admin: 3 };
const routes = [];
// access: 'public' | 'tech' | 'manager' | 'admin'
const add = (method, path, access, fn) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, access, fn });
};

// ---- public (no login)
add('GET', '/status', 'public', () => ({ setup_required: A.needsSetup(), setup_code_required: A.needsSetup() && !!process.env.SETUP_CODE, store_name: S.getSettings().store_name }));
add('POST', '/setup', 'public', (c) => {
  if (!A.needsSetup()) throw new S.AppError('Already set up', 403);
  // Optional: set SETUP_CODE in the environment so only you can create the first account.
  if (process.env.SETUP_CODE && String(c.body.setup_code || '') !== process.env.SETUP_CODE) throw new S.AppError('Wrong setup code', 403);
  const { store_name, sample_data, timezone, setup_code, ...user } = c.body;
  const u = A.saveUser({ name: user.name, email: user.email, password: user.password, role: 'admin' });
  const patch = {};
  if (store_name) patch.store_name = String(store_name).slice(0, 100);
  if (timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); patch.timezone = timezone; } catch {} }
  // The address the owner used to set up the shop becomes the public address for tracking links.
  if (c.origin && !/^https?:\/\/(localhost|127\.|\[::1\])/.test(c.origin)) patch.public_url = c.origin;
  S.updateSettings(patch);
  if (sample_data) seedDemo(u);
  c.login(u.id);
  return u;
});
add('POST', '/login', 'public', (c) => { const u = A.login(c.body.email, c.body.password, c.ip); c.login(u.id); return u; });
add('POST', '/logout', 'tech', (c) => { if (c.user.id) A.endSessions(c.user.id); c.logout(); return { ok: true }; });
add('GET', '/track/:code', 'public', (c) => S.publicTicket(c.params.code));

// ---- signed in
add('GET', '/me', 'tech', (c) => ({ ...c.user, ...(c.user.id ? S.clockStatus(c.user) : {}) }));
add('POST', '/clock/:action', 'tech', (c) => S.clock(c.user, c.params.action));
add('GET', '/dashboard', 'tech', () => S.dashboard());

add('GET', '/settings', 'tech', (c) => { const s = S.getSettings(); if (c.user.role !== 'admin') delete s.webhooks; return s; });
add('PUT', '/settings', 'admin', (c) => S.updateSettings(c.body));
add('POST', '/webhooks/test', 'admin', (c) => { S.emit('test', { message: 'Test event from OpenRepairPOS', store: S.getSettings().store_name }); return { ok: true }; });

add('GET', '/users', 'tech', () => A.listUsers());
add('POST', '/users', 'admin', (c) => A.saveUser(c.body));
add('PUT', '/users/:id', 'admin', (c) => { const u = A.saveUser(c.body, c.id); if (c.user.id === c.id) c.login(c.id); return u; });
add('GET', '/api-keys', 'admin', () => A.listApiKeys());
add('POST', '/api-keys', 'admin', (c) => A.createApiKey(c.body.name));
add('DELETE', '/api-keys/:id', 'admin', (c) => A.deleteApiKey(c.id));

add('GET', '/customers', 'tech', (c) => S.searchCustomers(c.query));
add('POST', '/customers', 'tech', (c) => S.saveCustomer(c.body));
add('GET', '/customers/:id', 'tech', (c) => S.getCustomer(c.id));
add('PUT', '/customers/:id', 'tech', (c) => S.saveCustomer(c.body, c.id));
add('POST', '/customers/:id/store-credit', 'manager', (c) => S.addStoreCredit({ ...c.body, customer_id: c.id }, c.user));

add('GET', '/tickets', 'tech', (c) => S.listTickets({ ...c.query, open: c.query.open === '1', assigned_to: c.query.assigned_to ? Number(c.query.assigned_to) : null, customer_id: c.query.customer_id ? Number(c.query.customer_id) : null }));
add('POST', '/tickets', 'tech', (c) => S.createTicket(c.body, c.user));
add('GET', '/tickets/:id', 'tech', (c) => S.getTicket(c.params.id));
add('PUT', '/tickets/:id', 'tech', (c) => S.updateTicket(c.id, c.body, c.user));
add('POST', '/tickets/:id/notes', 'tech', (c) => {
  if (!['internal', 'diagnostic'].includes(c.body.type || 'internal')) throw new S.AppError('type must be internal or diagnostic');
  S.addNote({ ticket_id: c.id, type: c.body.type || 'internal', body: String(c.body.body || '') }, c.user);
  return S.getTicket(c.id);
});
add('POST', '/tickets/:id/items', 'tech', (c) => S.addTicketItem({ ...c.body, ticket_id: c.id }, c.user));
add('DELETE', '/tickets/:id/items/:line', 'tech', (c) => S.removeTicketItem({ ticket_id: c.id, line_id: Number(c.params.line) }, c.user));
add('POST', '/tickets/:id/invoice', 'tech', (c) => S.createInvoice({ ...c.body, ticket_id: c.id }, c.user));
add('POST', '/tickets/:id/deposits', 'tech', (c) => S.addDeposit({ ...c.body, ticket_id: c.id }, c.user));
add('DELETE', '/tickets/:id/deposits/:dep', 'manager', (c) => S.removeDeposit({ ticket_id: c.id, deposit_id: Number(c.params.dep) }, c.user));
add('POST', '/tickets/:id/timer/:action', 'tech', (c) => S.ticketTimer({ ticket_id: c.id, action: c.params.action }, c.user));
add('POST', '/tickets/:id/time', 'tech', (c) => S.addManualTime({ ...c.body, ticket_id: c.id }, c.user));

add('GET', '/items', 'tech', (c) => S.searchItems({ ...c.query, low: c.query.low === '1' }));
add('POST', '/items', 'manager', (c) => S.saveItem(c.body, null, c.user));
add('POST', '/items/import', 'manager', (c) => S.importItems(c.body.items, c.user));
add('GET', '/items/:id', 'tech', (c) => S.getItem(c.id));
add('PUT', '/items/:id', 'manager', (c) => S.saveItem(c.body, c.id, c.user));
add('DELETE', '/items/:id', 'manager', (c) => S.deleteItem(c.id));
add('POST', '/items/:id/adjust', 'manager', (c) => S.adjustStock({ ...c.body, item_id: c.id }, c.user));
add('POST', '/items/:id/serials', 'manager', (c) => S.addSerials({ item_id: c.id, serials: c.body.serials || [] }, c.user));
add('POST', '/stock-count', 'manager', (c) => S.stockCount(c.body, c.user));

add('GET', '/prices', 'tech', (c) => S.listPrices(c.query));
add('POST', '/prices', 'manager', (c) => S.savePrice(c.body));
add('PUT', '/prices/:id', 'manager', (c) => S.savePrice(c.body, c.id));
add('DELETE', '/prices/:id', 'manager', (c) => S.deletePrice(c.id));
add('GET', '/quote', 'tech', (c) => S.quoteRepair(c.query));

add('GET', '/invoices', 'tech', (c) => S.listInvoices(c.query));
add('POST', '/invoices', 'tech', (c) => S.createInvoice(c.body, c.user));
add('GET', '/invoices/:id', 'tech', (c) => S.getInvoice(c.params.id));
add('POST', '/invoices/:id/payments', 'tech', (c) => S.recordPayment({ ...c.body, invoice_id: c.id }, c.user));
add('POST', '/invoices/:id/void', 'manager', (c) => S.voidInvoice(c.id, c.user));

add('GET', '/purchase-orders', 'manager', () => S.listPOs());
add('POST', '/purchase-orders', 'manager', (c) => S.createPO(c.body));
add('GET', '/purchase-orders/:id', 'manager', (c) => S.getPO(c.id));
add('POST', '/purchase-orders/:id/status', 'manager', (c) => S.setPOStatus(c.id, c.body.status));
add('POST', '/purchase-orders/:id/receive', 'manager', (c) => S.receivePO({ po_id: c.id, lines: c.body.lines }, c.user));
add('GET', '/parts-order-list', 'tech', () => S.partsOrderList());

add('GET', '/appointments', 'tech', (c) => S.listAppointments(c.query));
add('POST', '/appointments', 'tech', (c) => S.bookAppointment(c.body, c.user));
add('PUT', '/appointments/:id', 'tech', (c) => S.updateAppointment(c.id, c.body));

add('GET', '/reports', 'manager', (c) => S.report(c.query));

// ------------------------------------------------------------------ dispatcher
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data ?? { ok: true }), { status, headers: { 'Content-Type': 'application/json', ...headers } });
// Browsers send Origin on every POST/PUT/DELETE; fall back to Sec-Fetch-Site for older ones.
function sameOrigin(request, url) {
  const origin = request.headers.get('origin');
  if (origin) { try { return new URL(origin).host === url.host; } catch { return false; } } // host only: works behind HTTPS proxies
  const site = request.headers.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}
const cookieOf = (req, name) => (req.headers.get('cookie') || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(name + '='))?.slice(name.length + 1);

async function handleApi(request, path, ip = '') {
  const url = new URL(request.url);
  const route = routes.find((r) => r.method === request.method && r.re.test(path));
  if (!route) { await request.arrayBuffer().catch(() => {}); return json({ error: 'Not found' }, routes.some((r) => r.re.test(path)) ? 405 : 404); }

  const headers = {};
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  let params;
  try { params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(path.match(route.re)[i + 1])])); } catch { return json({ error: 'Bad request' }, 400); }
  const c = {
    params,
    query: Object.fromEntries(url.searchParams),
    body: {},
    origin: url.origin,
    ip,
    login: (id) => { headers['Set-Cookie'] = `${COOKIE}=${encodeURIComponent(A.makeSession(id))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 86400}${secure}`; },
    logout: () => { headers['Set-Cookie'] = `${COOKIE}=; Path=/; Max-Age=0`; },
  };
  c.id = Number(c.params.id);

  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      const text = await request.text();
      if (text.length > 5e6) throw new S.AppError('Request too large', 413);
      if (text) { try { c.body = JSON.parse(text); } catch { throw new S.AppError('Invalid JSON'); } }
    }
    if (route.access !== 'public') {
      const auth = request.headers.get('authorization') || '';
      const bearer = auth.startsWith('Bearer ');
      let cookie = ''; try { cookie = decodeURIComponent(cookieOf(request, COOKIE) || ''); } catch {}
      c.user = bearer ? A.checkApiKey(auth.slice(7).trim()) : A.readSession(cookie);
      if (!c.user) return json({ error: 'Not signed in' }, 401);
      if (rank[c.user.role] < rank[route.access]) return json({ error: `Requires ${route.access} role` }, 403);
      // Cookie-authenticated writes must come from our own pages (CSRF protection).
      if (!bearer && request.method !== 'GET' && !sameOrigin(request, url)) return json({ error: 'Cross-site request blocked' }, 403);
    } else if (request.method !== 'GET' && !sameOrigin(request, url)) return json({ error: 'Cross-site request blocked' }, 403);
    return json(await route.fn(c), 200, headers);
  } catch (e) {
    const f = S.friendlyError(e);
    if (!f) { console.error(e); return json({ error: 'Server error' }, 500); }
    return json({ error: f.message }, f.status || 400);
  }
}

module.exports = { handleApi };
