// Users, sessions (signed cookies) and API keys. Only the crypto module — works on Node.js and Cloudflare.
const crypto = require('node:crypto');
const { all, get, run, kvGet, kvSet } = require('./db');
const { AppError } = require('./services');

// Session secret: from env, or generated once and stored in the database.
let SECRET = null;
function secret() {
  if (SECRET) return SECRET;
  SECRET = process.env.SESSION_SECRET || kvGet('session_secret');
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); kvSet('session_secret', SECRET); }
  return SECRET;
}
const ROLES = ['admin', 'manager', 'tech'];
const SESSION_DAYS = 14;

// PBKDF2-SHA256. Iterations are stored with each hash so they can be raised later without breaking logins.
const ITERATIONS = Number(process.env.PASSWORD_ITERATIONS) || 210000;
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `pbkdf2$${ITERATIONS}$${salt}$${crypto.pbkdf2Sync(pw, salt, ITERATIONS, 32, 'sha256').toString('hex')}`;
}
function checkPassword(pw, stored) {
  let test; let hash;
  if (stored.startsWith('pbkdf2$')) {
    const [, iter, salt, h] = stored.split('$');
    hash = h; test = crypto.pbkdf2Sync(pw, salt, Number(iter), 32, 'sha256');
  } else { // v0.1.0 scrypt hashes
    const [salt, h] = stored.split(':');
    hash = h; test = crypto.scryptSync(pw, salt, 64);
  }
  const want = Buffer.from(hash, 'hex');
  return want.length === test.length && crypto.timingSafeEqual(test, want);
}

// Brute-force protection: 10 failed logins per email + IP address per 15 minutes,
// so an attacker elsewhere can't lock the owner out. The map is capped to avoid memory growth.
const failures = new Map();
function throttle(email, ip = '') {
  const k = `${email.toLowerCase()}|${ip}`; const now = Date.now();
  const list = (failures.get(k) || []).filter((t) => now - t < 15 * 60e3);
  if (list.length) failures.set(k, list); else failures.delete(k);
  if (list.length >= 10) throw new AppError('Too many attempts. Try again in 15 minutes.', 429);
  return () => {
    if (failures.size > 5000) failures.delete(failures.keys().next().value);
    list.push(now); failures.set(k, list);
  };
}
const DUMMY_HASH = `pbkdf2$${ITERATIONS}$00000000000000000000000000000000$${'0'.repeat(64)}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sign = (v) => crypto.createHmac('sha256', secret()).update(v).digest('base64url');

// Session token: userId.sessionVersion.expiry.signature. Bumping a user's session_version
// (sign out, password/role change, deactivation) invalidates all of their sessions.
function makeSession(userId) {
  const v = get('SELECT session_version FROM users WHERE id = ?', userId)?.session_version ?? 0;
  const payload = `${userId}.${v}.${Date.now() + SESSION_DAYS * 864e5}`;
  return `${payload}.${sign(payload)}`;
}
function readSession(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const payload = parts.slice(0, 3).join('.');
  const good = Buffer.from(sign(payload));
  const given = Buffer.from(parts[3]);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
  if (Number(parts[2]) < Date.now()) return null;
  const u = get('SELECT * FROM users WHERE id = ? AND active = 1', Number(parts[0]));
  if (!u || u.session_version !== Number(parts[1])) return null;
  return publicUser(u);
}
function endSessions(userId) { run('UPDATE users SET session_version = session_version + 1 WHERE id = ?', userId); }
const publicUser = (u) => (u ? { id: u.id, name: u.name, email: u.email, role: u.role } : null);

function needsSetup() { return get('SELECT COUNT(*) AS n FROM users').n === 0; }

function login(email, password, ip = '') {
  const fail = throttle(String(email || ''), ip);
  const u = get('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1', String(email || ''));
  // Always run the hash so response time doesn't reveal which emails have accounts.
  const ok = checkPassword(String(password || ''), u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) { fail(); throw new AppError('Wrong email or password', 401); }
  return publicUser(u);
}

function listUsers() { return all('SELECT id, name, email, role, active, commission_rate, created_at FROM users ORDER BY id'); }
function saveUser({ name, email, password, role, active, commission_rate }, id = null) {
  if (commission_rate !== undefined && commission_rate !== null && (Number(commission_rate) < 0 || Number(commission_rate) > 100)) throw new AppError('commission_rate must be between 0 and 100');
  if (role && !ROLES.includes(role)) throw new AppError(`role must be one of ${ROLES.join(', ')}`);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Please enter a valid email address');
  if (password && String(password).length < 8) throw new AppError('Password must be at least 8 characters');
  if (id) {
    const cur = get('SELECT * FROM users WHERE id = ?', id);
    if (!cur) throw new AppError('User not found', 404);
    if (email && get('SELECT 1 FROM users WHERE lower(email) = lower(?) AND id <> ?', email, id)) throw new AppError('Email already in use');
    const losingAdmin = cur.role === 'admin' && cur.active && ((role && role !== 'admin') || (active !== undefined && !active));
    if (losingAdmin && get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").n <= 1) throw new AppError('You need at least one active admin');
    const sets = []; const vals = [];
    if (name) { sets.push('name = ?'); vals.push(name); }
    if (email) { sets.push('email = ?'); vals.push(email); }
    if (role) { sets.push('role = ?'); vals.push(role); }
    if (active !== undefined) { sets.push('active = ?'); vals.push(active ? 1 : 0); }
    if (password) { sets.push('password_hash = ?'); vals.push(hashPassword(password)); }
    if (commission_rate !== undefined && commission_rate !== null) { sets.push('commission_rate = ?'); vals.push(Number(commission_rate) || 0); }
    if (password || (role && role !== cur.role) || (active !== undefined && !!active !== !!cur.active)) sets.push('session_version = session_version + 1'); // sign out everywhere
    if (sets.length) run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    return publicUser(get('SELECT * FROM users WHERE id = ?', id));
  }
  if (!name || !email || !password) throw new AppError('name, email and password are required');
  role = role || 'tech';
  if (password.length < 8) throw new AppError('Password must be at least 8 characters');
  if (get('SELECT 1 FROM users WHERE lower(email) = lower(?)', email)) throw new AppError('Email already in use');
  const r = run('INSERT INTO users (name, email, password_hash, role, commission_rate) VALUES (?,?,?,?,?)', name, email, hashPassword(password), role, Number(commission_rate) || 0);
  return publicUser(get('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid)));
}

// API keys: shown once, stored only as a hash. Used by the REST API and the MCP server.
function createApiKey(name) {
  const key = 'orp_' + crypto.randomBytes(24).toString('base64url');
  run('INSERT INTO api_keys (name, prefix, key_hash) VALUES (?,?,?)', name || 'API key', key.slice(0, 7), sha(key));
  return { key, name };
}
function listApiKeys() { return all('SELECT id, name, prefix, created_at, last_used_at FROM api_keys ORDER BY id DESC'); }
function deleteApiKey(id) { run('DELETE FROM api_keys WHERE id = ?', id); return { ok: true }; }
function checkApiKey(key) {
  if (!key || !key.startsWith('orp_')) return null;
  const k = get('SELECT * FROM api_keys WHERE key_hash = ?', sha(key));
  if (!k) return null;
  run('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', k.id);
  return { id: null, name: `API: ${k.name}`, role: 'manager', api_key_id: k.id };
}

module.exports = { makeSession, readSession, endSessions, login, needsSetup, listUsers, saveUser, createApiKey, listApiKeys, deleteApiKey, checkApiKey, ROLES };
