// OpenRepairPOS on Cloudflare (the one-click "Deploy to Cloudflare" version).
// Static files (public/) are served by Cloudflare directly; API, MCP and tracking pages come here.
// All data lives in one Durable Object with built-in SQLite — one shop per deployment, no database to set up.
import { DurableObject } from 'cloudflare:workers';
import { setDriver, migrate } from './db.js';
import { durableDriver } from './drivers/durable.js';
import { handle } from './app.js';
import { setBackground } from './notify.js';

export class Shop extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    setDriver(durableDriver(ctx.storage));
    setBackground((p) => ctx.waitUntil(p));
    migrate();
  }

  fetch(request) {
    return handle(request, (pathname) => this.env.ASSETS.fetch(new URL(pathname, request.url)), request.headers.get('cf-connecting-ip') || '');
  }
}

export default {
  fetch(request, env) {
    return env.SHOP.get(env.SHOP.idFromName('shop')).fetch(request);
  },
};
