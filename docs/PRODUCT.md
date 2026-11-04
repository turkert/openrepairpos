# OpenRepairPOS — product truth

The single source of truth for what OpenRepairPOS is and does. The website, guides, FAQ, social posts and anything an AI says about the product must agree with this file. If a feature isn't listed under "What it does today", don't claim it.

- **Version described:** 0.5.0
- **Last checked against the code:** 2026-11-03
- **Website:** https://openrepairpos.com
- **Source code:** https://github.com/turkert/openrepairpos *(repository not yet published)*
- **License:** MIT (free to use, change and share, including commercially)
- **Made by:** OpenRepairPOS, an independent open-source project (MIT), maintained by its contributors. The app includes a built-in Parts4Cells reorder integration that cannot be switched off (owner decision 2026-11-03); the maintainers have a working relationship with Parts4Cells, which is disclosed on the website's disclosure page.

---

## In one sentence

OpenRepairPOS is free, open-source software for running a repair shop (tickets, point of sale, inventory, invoices and reports), which each shop runs in its own free Cloudflare account and can control from Claude or ChatGPT.

## Who it's for

- **Main audience:** independent phone, tablet and computer repair shops, from one technician to a small team.
- **Also fits:** other repair shops that check in an item, fix it and invoice for it (watches, cameras, consoles, small electronics). Shops can add their own ticket fields, such as VIN or mileage.
- **Not built for:** multi-location chains, franchise management, mail-in repair depots or warranty centers. Those features don't exist yet.

## What it costs

| | Cost |
|---|---|
| The software | Free. No subscription, no per-user or per-ticket fees. |
| Hosting on Cloudflare | Free on the Cloudflare Workers Free plan for a typical shop. Cloudflare's limits apply, e.g. 100,000 requests a day. |
| Optional extras the shop pays for directly | SMS (Twilio), email (Resend or the shop's own email server), its own domain name. |
| Claude or ChatGPT | The shop's own plan. See "AI assistants" for which plans work. |

The project doesn't host shops, store their data or charge for anything.

---

## How a shop gets it

### Option 1: One-click on Cloudflare (recommended)
1. Click **Deploy to Cloudflare** on openrepairpos.com or the GitHub page.
2. Sign in to (or create) a free **Cloudflare** account and a free **GitHub** account. Both are required: Cloudflare copies the code into the shop's GitHub, then builds and runs it.
3. Click **Deploy**. Cloudflare creates the app and its database. It takes about two minutes.
4. Open the new address (e.g. `openrepairpos.<name>.workers.dev`) and create the owner account. Tick "Add sample data" to try it with sample data first.
5. Optional: connect the shop's own domain in Cloudflare (e.g. `repairs.myshop.com`).

**Important:** whoever opens a fresh install first becomes its owner, so the shop should create its account right after deploying. Shops that want extra safety can add a `SETUP_CODE` variable in Cloudflare before opening the address.

### Option 2: Run it on your own computer or server
Docker (`docker compose up -d`) or Node.js 22.5+ (`npm start`). Data is a single SQLite file in the `data/` folder. Claude and ChatGPT can only reach it if the shop also puts it online over HTTPS. This option is for technical users.

### Updates
A Cloudflare install is a copy in the shop's GitHub account. It does **not** update automatically when a new version is released. *(An update notice and one-click update are planned.)*

---

## What it does today

### Repair tickets
- Check in a device: customer, device type, brand, model, IMEI/serial, passcode, problem, priority, due date.
- Repair type (editable list) and up to 30 shop-defined extra fields (e.g. VIN, mileage, color).
- Quick pick from the shop's repair price list, which fills in device, price and warranty, and reserves the linked part.
- Pre-repair and post-repair checklists (editable list).
- Custom statuses in the shop's own order. Default: New → Diagnosing → Waiting for approval → Waiting for parts → In repair → Ready for pickup → Completed / Cancelled.
- List view and drag-and-drop board view. Overdue tickets are highlighted. Filter by status, technician and text.
- Assign a technician. Internal notes (staff only) and diagnostic notes (shown to the customer).
- Parts and labor lines. Parts come out of stock when added and go back when removed.
- **Deposits** taken at check-in or later. They're applied to the invoice automatically. Any excess becomes store credit.
- **Job timer:** start/stop per technician, plus manual time entries.
- Warranty days per ticket.
- Customer signature on the shop's terms, collected on screen by mouse, finger or pen.
- Printable bench label and drop-off receipt.
- Once a ticket is invoiced, its parts and labor are locked. Voiding the invoice unlocks them.

### Customer updates
- Each ticket has a private tracking link. It shows status, progress, estimate, due date and technician updates, with no login. Internal notes and passcodes are never shown.
- Automatic email and/or SMS when a ticket reaches chosen statuses. Default: Waiting for approval, Waiting for parts, Ready for pickup. Email needs Resend or SMTP; SMS needs Twilio. Either can also go to a webhook.

### Point of sale and invoices
- Product tiles, search and barcode scanning (any USB/Bluetooth scanner that types).
- Edit quantity and price, discount, sales tax (one shop-wide rate, with per-item taxable/non-taxable).
- Payment methods: cash (with change calculation), card, bank transfer, store credit, other.
- **Card payments by design:** cards run on the shop's own terminal, so the shop keeps its processor and rates, and card numbers never enter OpenRepairPOS (no card data to protect, no processor lock-in). The payment is then recorded here. Public wording: present this as a benefit, not as a missing feature (owner decision 2026-11-04).
- Partial payments and unpaid invoices. One-click invoice from a ticket.
- Print or save as PDF through the browser.
- Void an invoice: retail stock returns, store credit is refunded, deposits go back to the ticket. Cash/card refunds are flagged for the shop to handle.

### Customers
- Search by name, phone, email or company. Each customer shows their tickets and invoices.
- Store credit balance (managers can adjust it).

### Inventory and purchasing
- Parts, retail products and services. SKU, barcode, category, cost, price, supplier, supplier SKU, low-stock level.
- Low-stock alerts and full stock history with reasons, including returns to supplier (RMA).
- Serial/IMEI numbers per item.
- Stock count screen. CSV import.
- Purchase orders: create, mark ordered, receive in full or in part. Receiving updates stock and cost.
- **Parts4Cells reorder list:** low-stock items with suggested quantities and a "Find on Parts4Cells" link each, a downloadable order list, and one click to turn them into a purchase order. It links to Parts4Cells' search; it doesn't place orders or check live prices or stock.

### Appointments
- Two-week planner. Book, mark done, cancel. Bookings can also come from an AI assistant.

### Reports
- Revenue, gross profit, tax collected, cost of goods, outstanding balances, deposits held, inventory value.
- Daily sales, payments by method, top devices, top sellers.
- **Profit by repair type:** jobs, revenue, parts cost, profit, profit per job, margin.
- **Technicians:** tickets closed, hours logged, revenue, profit, revenue per hour, commission.
- Any date range, in the shop's time zone. CSV export.

### Team
- Unlimited users. Roles:
  - **tech:** tickets, customers, POS, appointments.
  - **manager:** adds inventory, purchasing, reports, voids, store credit.
  - **admin:** adds settings, users, API keys, webhooks.
- Commission % per technician, based on profit or on revenue.
- Clock in / clock out.

### AI assistants (Claude and ChatGPT)
OpenRepairPOS includes an MCP server, the standard way AI assistants connect to apps. Once connected, the shop can work by chat, e.g.:
- "What's waiting for parts?"
- "Check in an iPhone 13 screen for Maria, 713-555-0142, deposit $50 cash"
- "Mark T-1004 ready for pickup"
- "Book Kevin tomorrow at 3pm"
- "What's low on stock? Make a Parts4Cells purchase order"
- "Profit by repair type this month?"

**Tools available to the AI:** search, fetch, find/get/create customer, list/get/create ticket, change status, add note, add part or labor, record deposit, log repair time, quote repair (from the price list), search inventory, adjust stock, Parts4Cells reorder list, create purchase order, create/get invoice, record payment, list/book appointments, shop report, shop info.

**How to connect:**
1. In OpenRepairPOS: Settings → AI & API → Create key. Copy the MCP link.
2. **Claude:** Customize → Connectors → + Add → Add custom connector → paste the link. Works on all Claude plans; the Free plan allows one custom connector. Once added, it also works in the Claude mobile apps.
3. **ChatGPT:** turn on Developer mode, then add the link as an app. This is a beta and needs a paid plan. *Plan details vary by source; verify on OpenAI's help center before publishing a specific plan list.*

**Limits:**
- The shop must be online over HTTPS. Cloudflare installs are.
- API keys act with **manager** rights. Shops should create one key per assistant and revoke unused keys.
- Assistants ask for confirmation before making changes.
- Device passcodes are never sent to the AI assistant. Internal notes are (they're staff data, and the assistant acts as staff).

### Integrations
- **Webhooks:** send events to Zapier, Make, n8n or custom code. Events: ticket created, status changed, deposit, invoice created/paid/voided, customer created, appointment booked, stock low. Optional HMAC signature.
- **REST API:** everything the app does, with an API key.

### Security and data
- Each shop's data is in its own Cloudflare account (or on its own server). Nobody else, including the project, has access.
- Passwords are hashed (PBKDF2). Sessions end on sign-out or password/role change. Logins are rate-limited.
- Strict browser security policy, checks against requests from other sites, role checks on every action.
- Reviewed before release for business-logic, security and usability bugs, plus a final independent launch review (2026-11-03). All confirmed issues were fixed and are covered by automated tests.

### Runs on
Any modern browser on a PC, Mac, tablet or phone. There's no app to install. The layout works down to phone width.

---

## What we're working on (not available yet)

Don't claim these as available. Public wording: **"We're working on it."** Never give dates.
- Loyalty points and gift cards.
- Online booking widget or repair-quote widget for the shop's website.
- Self check-in kiosk or a separate customer-facing display (signatures are collected on the shop's own screen).
- Device buyback / trade-in.
- Multiple locations, stock transfers, franchise tools.
- QuickBooks / Xero sync, Shopify / WooCommerce sync.
- Email/SMS marketing campaigns, Google review requests.
- AI phone receptionist.
- Offline mode, native mobile apps.
- Automatic updates for Cloudflare installs.
- Translations (English only).
- Live Parts4Cells catalog, prices, stock or ordering inside the app.
- Multiple tax rates per sale.

## Roadmap (planned, not promised)

1. Update notice and one-click update for Cloudflare installs.
2. Online booking and repair-quote widget.
3. Loyalty points and gift cards.
4. Kiosk / self check-in.
5. Buyback / trade-in.
6. Multi-location.
7. QuickBooks / Xero export.
8. Live Parts4Cells catalog and cart.
9. Translations.

## Wording rules for marketing

- Say **"free and open source"**. Don't say "free forever" or make promises about future pricing.
- Say **"runs in your own free Cloudflare account"**. Mention that a GitHub account is also needed.
- Say **"works with Claude and ChatGPT"** with the plan notes above. Don't claim support for other assistants unless tested.
- **Don't name competitors** on the website or in marketing. Compare against "a typical paid repair POS" / "one of the most widely used paid repair-shop systems", using that vendor's own published pages, dated, with the evidence kept in `operations/research/` (private).
- Don't use competitors' names, logos, screenshots or wording.
- **Independent project:** don't present OpenRepairPOS as a Parts4Cells product or say it is sponsored by Parts4Cells. Do keep the disclosure: the app has built-in Parts4Cells reorder links (always on; buying through them is optional, any supplier can be used) and the maintainers have a working relationship with Parts4Cells.
- **Zero data collection:** the app sends no analytics, usage data, owner emails or shop data to the project or anyone else (owner decision 2026-11-03). Never add telemetry without changing this file and the website first.
- Missing features: say **"We're working on it"**, never a date.
