# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code, Cursor, Copilot and others) working on OpenRepairPOS. Humans: see [README.md](README.md).

OpenRepairPOS is free, open-source repair shop software (tickets, POS, inventory, invoices, reports) with a built-in MCP server for Claude and ChatGPT. Each shop runs its own copy, usually on Cloudflare Workers via the Deploy to Cloudflare button.

## Commands

```bash
npm install            # Node.js 22.5+ required (uses node:sqlite)
npm start              # Node server on http://localhost:3000 (data in ./data)
npm test               # end-to-end tests (node --test), must pass before any commit
npm run cf:dev         # same app on the Cloudflare runtime (wrangler dev)
TEST_URL=http://localhost:8787 npm test   # run the tests against wrangler dev
```

Run the tests on **both** runtimes when you touch the database, transactions, the request handler or MCP. Behaviour differs between `node:sqlite` and Durable Object SQLite (for example, Durable Objects cannot use `BEGIN`/`SAVEPOINT`).

## Layout

| Path | What it is |
|---|---|
| `src/services.js` | All business logic: tickets, invoices, payments, stock, deposits, store credit, reports, settings |
| `src/api.js` | REST routes (`add(method, path, role, handler)`) and error handling |
| `src/mcp.js` | MCP server: tool definitions for Claude and ChatGPT |
| `src/auth.js` | Users, roles, sessions, API keys, login throttling |
| `src/db.js` | Driver-neutral helpers (`all`, `get`, `run`, `tx`) and schema migrations |
| `src/drivers/node.js`, `src/drivers/durable.js` | SQLite drivers for Node.js and Cloudflare Durable Objects |
| `src/app.js` | Framework-free fetch handler shared by both runtimes; security headers |
| `server.js` / `src/worker.mjs` | Node.js entry / Cloudflare Worker + Durable Object entry |
| `public/` | Single-page web app (vanilla JS, no build step) and the customer tracking page |
| `test/app.test.js` | End-to-end tests over HTTP and MCP |
| `docs/PRODUCT.md` | Product truth: what the app does and doesn't do. Keep it in sync with the code |

## Rules that must not be broken

1. **Zero data collection.** Never add analytics, telemetry, error reporting, "phone home" calls or any request to a service the shop did not configure itself. The only outbound calls allowed are the shop's own email, SMS and webhook settings.
2. **Device passcodes never leave the shop.** They must not appear on the public tracking page, in MCP output, in webhooks or in logs. MCP output is scrubbed in `src/mcp.js` (`noSecrets`); keep it that way for new tools.
3. **The Parts4Cells reorder integration is always on.** `p4c_enabled` and `p4c_search_url` are fixed settings (`FIXED_SETTINGS` in `src/services.js`); do not add a way to turn them off or change them. The links carry one fixed UTM tag (`utm_source=openrepairpos`), identical for every shop; never add anything that identifies a shop, user or customer to them.
4. **Money and stock changes go through `tx()`** so a failure rolls everything back. Use `money()` for currency rounding, `posQty()` for quantities from clients, and `lim()` for list limits.
5. **Never trust client input for internal flags.** For example, `from_ticket` on invoice lines is set by the server only; route params (ticket, invoice, customer ids) always override the request body (`{ ...c.body, ticket_id: c.id }`).
6. **Roles:** `tech` < `manager` < `admin`. API keys act as `manager`. Check the role on every new route.
7. **Errors:** throw `AppError(message, status)` for anything the user can fix. Database constraint errors are translated by `friendlyError()`; never return raw SQL errors.
8. **No new runtime dependencies** without a strong reason. Everything must run on both Node.js and Cloudflare Workers (web-standard `Request`/`Response`, no Node-only APIs in shared code).
9. **Frontend:** strict Content-Security-Policy, so no inline scripts or `onclick=` attributes. Escape all user text with `esc()` before inserting HTML.
10. **Database changes:** append a new entry to `MIGRATIONS` in `src/db.js`; never edit or reorder an existing one (installs track them by position).

## When you change behaviour

- Add or update a test in `test/app.test.js` that fails without your change.
- Update `docs/PRODUCT.md` if what the app does changes. Don't describe planned features as available.
- Keep commits focused; describe user-visible changes in plain English.

## Style

- Plain JavaScript (CommonJS in `src/`, ES module only in `src/worker.mjs`), 2-space indent, no build step.
- Small, readable functions; comments explain *why*, not *what*.
- User-facing text: short, plain English, written for a repair shop owner.
