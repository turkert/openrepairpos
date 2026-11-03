// The whole app as one fetch-style handler: (Request) → Response.
// server.js (Node.js) and worker.mjs (Cloudflare) are thin wrappers around this.
const { handleApi } = require('./api');
const { handleMcp } = require('./mcp');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  // Only our own scripts may run; blocks injected <script> and inline event handlers.
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'; object-src 'none'",
};

// serveAsset(pathname, request) returns a Response for a file in public/.
// ip is the client address, used for login throttling.
async function handle(request, serveAsset, ip = '') {
  const url = new URL(request.url);
  const path = url.pathname;

  let res;
  if (path === '/health') res = Response.json({ ok: true });
  else if (path.startsWith('/api/')) res = await handleApi(request, path.slice(4), ip);
  else if (path === '/mcp' || path.startsWith('/mcp/')) res = await handleMcp(request, path);
  else if (path.startsWith('/track/')) res = await serveAsset('/track.html', request);
  else res = await serveAsset(path === '/' ? '/index.html' : path, request);

  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if (path.startsWith('/api/') || path.startsWith('/mcp')) out.headers.set('Cache-Control', 'no-store');
  return out;
}

module.exports = { handle };
