# OpenRepairPOS

**Website:** [openrepairpos.com](https://openrepairpos.com) · **Deploy:** one click to Cloudflare · **License:** MIT

**Free, open-source software for running a repair shop** — repair tickets, point of sale, inventory, invoices, purchasing, appointments and reports. Deploy it to your own free Cloudflare account in one click, or self-host it. No monthly fee, no per-user limits, no per-ticket limits.

It also ships with a built-in **MCP server**, so you can connect **Claude** or **ChatGPT** and ask things like *"what's waiting for parts?"*, *"quote an iPhone 13 screen"*, or *"book Maria for 3pm tomorrow"*.

Made for phone, tablet and computer repair shops. OpenRepairPOS is an independent open-source project.

---

## What's included

| Area | Features |
|---|---|
| **Repair tickets** | Customer + device check-in, IMEI/serial, passcode, repair types, your own extra fields (e.g. VIN, mileage, color), deposits at check-in, custom statuses, due dates with overdue highlighting, list and drag-and-drop board views, technician assignment, pre/post-repair checklists, internal vs. customer-visible notes, parts & labor lines, warranty days, on-screen signature on your terms, printable receipts and bench labels |
| **Customer tracking page** | Every ticket gets a private link (`/track/…`) showing status, progress and technician updates — no login needed |
| **Notifications** | Automatic email (any SMTP) and/or SMS (Twilio) on chosen statuses, or send to a webhook (Zapier, Make, n8n) |
| **Point of sale** | Product tiles, barcode scanning, discounts, tax, cash/card/transfer/store-credit payments, change calculation, unpaid invoices and partial payments |
| **Invoices** | Create from a ticket in one click (deposits applied automatically), print/save as PDF, partial payments, void with stock return |
| **Inventory** | Parts, retail products and services; SKU/barcode; cost & price; low-stock alerts; adjustments with reasons (incl. supplier RMA); full stock history; serial/IMEI tracking; stock counts; CSV import |
| **Repair price list** | Device + repair + price, linked to the part it uses — powers quick quotes at check-in and AI quoting |
| **Purchasing** | Purchase orders, partial or full receiving, automatic cost updates, **one-click Parts4Cells reorder list** |
| **Appointments** | Two-week planner; bookings from staff or AI assistants |
| **Customers** | History of tickets and invoices, store credit |
| **Reports** | Revenue, gross profit, **profit and margin by repair type**, tax, outstanding balances, deposits held, daily sales, payment methods, top devices, top sellers, inventory value, CSV export |
| **Technicians** | Unlimited users with tech / manager / admin roles, job assignment, clock in/out, **per-job timer**, hours, revenue and profit per tech, **commissions** (% of profit or revenue) |
| **Integrations** | MCP server for Claude and ChatGPT, REST API with API keys, **webhooks** for Zapier, Make, n8n or your own plugins (signed with HMAC) |

## Install

### Option A — One click on Cloudflare (recommended, free)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/turkert/openrepairpos)

1. Click the button and sign in to Cloudflare (or create a free account).
2. Click **Deploy**. Cloudflare copies OpenRepairPOS to your account and gives you a web address like `https://openrepairpos.your-name.workers.dev`.
3. Open that address and create your shop. Tick **Add sample data** if you want to try it out first.

**Tip:** open your new address and create the owner account right away — the first person to open a fresh install becomes its admin. To lock that down, add a `SETUP_CODE` variable in Cloudflare (Workers → openrepairpos → Settings → Variables) before you open it; setup will then ask for that code.

That's it: HTTPS, the server and durable storage are handled by Cloudflare. It runs on the **Workers Free plan** (100,000 requests a day and 5 GB of storage — far more than a repair shop needs). Your data lives in your own Cloudflare account, not ours.

*Custom domain:* in Cloudflare go to Workers → openrepairpos → Settings → Domains & Routes and add e.g. `repairs.yourshop.com`.
*Updates:* the deploy button creates a copy of this repository in your GitHub account; pull in new releases there and Cloudflare redeploys automatically.

### Option B — Docker on your own server or shop PC

```bash
git clone https://github.com/turkert/openrepairpos.git
cd openrepairpos
docker compose up -d
```

Open <http://localhost:3000>. Your data is saved in `./data` — back that folder up.

### Option C — Node.js

Requires Node.js 22.5 or newer (it uses Node's built-in SQLite, so there is nothing to compile).

```bash
npm install
npm start          # http://localhost:3000
npm run seed       # optional: demo data (admin@example.com / changeme123)
npm test           # end-to-end tests
```

## Connect Claude or ChatGPT (MCP)

1. In OpenRepairPOS go to **Settings → AI & API → Create key** and copy the MCP URL. It looks like `https://your-shop.example.com/mcp/orp_xxxxx`.
2. Add it as a connector:
   - **Claude (claude.ai / desktop / mobile):** Settings → Connectors → *Add custom connector* → paste the URL.
   - **ChatGPT:** Settings → Apps & Connectors → Advanced → enable *Developer mode* → *Create* → paste the URL, authentication *No authentication*.
   - **Claude Code:** `claude mcp add --transport http openrepairpos https://your-shop.example.com/mcp --header "Authorization: Bearer orp_xxxxx"`
   - **Any other MCP client:** Streamable HTTP at `/mcp` with `Authorization: Bearer <key>`, or the key-in-URL form above.

Claude.ai and ChatGPT connect from the internet, so your OpenRepairPOS must be reachable over **HTTPS** — the Cloudflare install already is. Treat the MCP URL like a password; revoke keys any time in Settings.

**Tools the AI gets:** `search`, `fetch`, `find_customers`, `get_customer`, `create_customer`, `list_tickets`, `get_ticket`, `create_ticket`, `update_ticket_status`, `add_ticket_note`, `add_part_to_ticket`, `quote_repair`, `search_inventory`, `adjust_stock`, `parts_reorder_list`, `create_purchase_order`, `record_deposit`, `log_repair_time`, `create_invoice`, `get_invoice`, `record_payment`, `list_appointments`, `book_appointment`, `shop_report`, `shop_info`. Read-only tools are marked as such, so clients can ask for confirmation before anything that changes data. API keys act with **manager** rights; create a separate key per assistant and revoke any you no longer use.

## REST API

Every screen in the app uses the same JSON API, so anything the UI does, you can automate. Send `Authorization: Bearer orp_…` with a key from Settings.

```bash
curl -H "Authorization: Bearer $KEY" https://your-shop/api/tickets?open=1
curl -H "Authorization: Bearer $KEY" "https://your-shop/api/quote?device=iphone%2013&repair=screen"
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"customer":{"first_name":"Ana","phone":"713-555-0100"},"brand":"Apple","model":"iPhone 13","issue":"Cracked screen"}' \
     https://your-shop/api/tickets
```

Main routes: `/api/tickets`, `/api/customers`, `/api/items`, `/api/prices`, `/api/quote`, `/api/invoices`, `/api/purchase-orders`, `/api/parts-order-list`, `/api/appointments`, `/api/reports`, `/api/settings`. See `src/api.js` for the full list — it's one short file.

## Self-hosting tips (options B and C)

- Put it behind HTTPS (Caddy is easiest: `repairs.example.com { reverse_proxy localhost:3000 }`) and set `TRUST_PROXY=1` so the app sees the real client address and https. Leave it off if the app is exposed directly — forwarded headers can be forged.
- The public address for tracking links is taken from the address you used when creating the shop; change it any time in **Settings → Store → Public URL**. Reports use the shop's time zone (set at setup, editable in Settings → Store).
- Back up the `data/` folder. It holds the whole database (a single SQLite file).

## Configuration

Everything shop-related (name, tax rate, statuses, checklist, terms, notifications triggers) is in **Settings** inside the app. Notifications are switched on with environment variables — see `.env.example`. On Cloudflare, add them as secrets in Workers → openrepairpos → Settings → Variables and Secrets (use `RESEND_API_KEY` for email; SMTP is only available when self-hosting).

## Project layout

```
server.js            Node.js / Docker entry point
src/worker.mjs       Cloudflare entry point (Worker + Durable Object)
wrangler.jsonc       Cloudflare configuration used by the deploy button
src/app.js           the app as one fetch(Request) → Response handler, shared by both
src/db.js            SQLite schema + migrations (drivers in src/drivers/)
src/services.js      all business logic (shared by the API and MCP)
src/api.js           REST API
src/mcp.js           MCP server for AI assistants
src/auth.js          users, sessions, API keys
src/notify.js        email / SMS / webhook notifications
public/              the web app — plain HTML/CSS/JS, no build step
src/seed.js          sample data (setup wizard and `npm run seed`)
test/                end-to-end tests
```

No front-end framework and no build step on purpose: open `public/app.js`, change something, refresh. Business rules live in one file (`src/services.js`) so the web app and the AI tools always behave the same.

## Roadmap

Contributions welcome. Planned next:

- Online booking widget for shop websites and a public repair-quote widget
- Loyalty points and gift cards
- Self check-in kiosk mode and customer-facing display
- Device buyback / trade-in with serialized resale
- Multi-location stock and transfers
- QuickBooks / Xero export

## License

MIT — use it, change it, sell services around it. See [LICENSE](LICENSE).

OpenRepairPOS is an independent project and is not affiliated with any other repair-shop software vendor.

**Disclosure:** the app includes a built-in reorder list with links to the Parts4Cells parts catalog. Buying through those links is optional; you can use any supplier. OpenRepairPOS collects no data from your shop. See [openrepairpos.com/disclosure](https://openrepairpos.com/disclosure/).
