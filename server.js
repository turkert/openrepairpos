#!/usr/bin/env node
// OpenRepairPOS on Node.js (self-hosting / Docker). Start with: npm start
// For the one-click Cloudflare version see src/worker.js and wrangler.jsonc.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { setDriver, migrate } = require('./src/db');
const { nodeDriver } = require('./src/drivers/node');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
setDriver(nodeDriver(process.env.DB_FILE || path.join(DATA_DIR, 'openrepairpos.db')));
migrate();

const { handle } = require('./src/app');
const notify = require('./src/notify');

// Optional SMTP email (Node only — on Cloudflare use RESEND_API_KEY instead).
if (process.env.SMTP_HOST) {
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  notify.setSmtp(({ to, subject, text }) => t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text }));
}

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
async function serveAsset(pathname) {
  let decoded; try { decoded = decodeURIComponent(pathname); } catch { return new Response('Bad request', { status: 400 }); }
  const file = path.join(PUBLIC, path.normalize(decoded).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC + path.sep)) return new Response('Not found', { status: 404 });
  if (path.basename(file).startsWith('_')) return new Response('Not found', { status: 404 }); // config files like _headers (used by Cloudflare)
  try {
    const data = await fs.promises.readFile(file);
    return new Response(data, { headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
  } catch { return new Response('Not found', { status: 404 }); }
}

// Behind a reverse proxy (Caddy, nginx, Cloudflare Tunnel) set TRUST_PROXY=1 so the real
// client IP and https scheme are used. Without it, forwarded headers are ignored (they can be forged).
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_BODY = 6 * 1024 * 1024;

// Translate Node's request/response objects to the standard Request/Response the app uses.
const server = http.createServer(async (req, res) => {
  try {
    const first = (h) => String(req.headers[h] || '').split(',')[0].trim();
    const proto = TRUST_PROXY && first('x-forwarded-proto') ? first('x-forwarded-proto') : 'http';
    const host = (TRUST_PROXY && first('x-forwarded-host')) || req.headers.host || 'localhost';
    const ip = (TRUST_PROXY && (first('cf-connecting-ip') || first('x-forwarded-for'))) || req.socket.remoteAddress || '';
    let url;
    try { url = new URL(`${proto}://${host}${req.url}`).href; } catch { res.writeHead(400); return res.end('Bad request'); }
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) { res.writeHead(413); return res.end('Request too large'); }
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413); res.end('Request too large'); req.destroy(); return; }
      chunks.push(c);
    }
    const body = chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const response = await handle(new Request(url, { method: req.method, headers, body }), serveAsset, ip);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end('Server error');
  }
});

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`OpenRepairPOS running at http://localhost:${PORT}`);
    console.log(`MCP endpoint:            http://localhost:${PORT}/mcp`);
  });
}
module.exports = server;
