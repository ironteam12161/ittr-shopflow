# ITTR ShopFlow

Production shop-management PWA for **Iron Team Truck & Trailer Repair**.

## Current production line

**v24.76.x** — Work orders and the Repair Board, mechanic phone workflow with time clock, findings with photos, estimates with online customer approval, invoicing with payments (cash, check, Zelle, Stripe), bills and purchase orders, parts and barcode inventory, customer/unit service history and fleet portal, compliance (PM / CARB / annual inspections), reports, customer texting, AI assistance, Fullbay and Samsara tools, offline/PWA support, multilingual mechanic UI and role-based administration.

**Starting the shop on it:** follow `docs/GO-LIVE.md`.

## Repository layout

- `public/` — production browser/PWA assets and route modules served to users.
- `modules/` — canonical mirrored route modules used by the current build/release checks.
- `assets/` — application branding/assets.
- `database/` — database-related project files.
- `server.js` — Express/PostgreSQL backend and API routes.
- `schema.sql` + numbered `*.sql` files — schema/migration history. **Never reset production PostgreSQL when deploying.**
- `package.json` — Node runtime (Node 24, also in `.nvmrc`) and scripts. `npm start` runs `exec node server.js` so the server receives Railway's stop signal.
- `railway.json` / `Procfile` — Railway deployment configuration.
- `production_audit.mjs` — maintained production regression/security audit used by the release pipeline.
- `release_audit.mjs` — compatibility entry point that delegates to the canonical full check pipeline.
- `.env.example` — environment-variable template; real secrets must never be committed.

## Production rules

1. Deploy from `main` only after `npm run check` passes.
2. Do not commit `node_modules`, `.env`, ZIP packages, temporary files, browser-renamed duplicates such as `parts (4).html`, or old backup copies.
3. Keep the Fullbay inventory-import PostgreSQL parameter fix intact; do not regress the guarded import query.
4. Do not reset or recreate the Railway PostgreSQL database during application deployments.
5. Treat `public/modules/` as production UI code. Keep its required mirrored modules synchronized with `modules/`.
6. Keep version identifiers consistent across frontend, backend `/api/build`, package metadata, PWA cache/version markers, and release audits.
7. Use the normal startup command (`npm start`). On every start the server adds any missing tables and columns (safe to repeat, never destructive) before it accepts requests.

## Main product areas

**Operations:** Dashboard, Work Orders, Findings, mechanic time/activity and completed work.

**Customers & Vehicles:** Customer/unit directory, VIN/USDOT data and unified service history.

**Finance:** Estimates (quote → approve → convert to invoice), labor-centric invoicing, work-order sync, parts/fees/discounts, tire user + disposal fees, payments, PDF/print and invoice service-history records.

**Reports:** Accountant-ready sales, collections, customers-owe aging, parts usage/profit, vendor spend and tire-fee remittance with charts, CSV export and print. Includes a read-only Gmail money inbox for Zelle notices and vendor bills. See `docs/AUDIT-2026-09-30.md` for setup.

**Parts:** Inventory, manufacturer/internal barcode scanning, physical inventory and Smart Vendor Receiving.

**Inventory:** reserve on work order, take out of stock on invoice finalize.

**Integrations & AI:** Fullbay import/history tools, Samsara fleet data and Workshop AI.

## Local validation

Install dependencies, then run the same maintained release path used by CI:

```bash
npm run check
```

`npm run check` needs a throw-away PostgreSQL database (`DATABASE_URL`, plus `ITTR_LANGUAGE_TEST_DB=1`) and Chromium for the browser suites; each suite creates and drops its own schema. Never point it at the production database. `ITTR_TEST_NODE_ENV=production` runs the suites against a production-mode server.

Older instructions may still reference:

```bash
node release_audit.mjs
```

That compatibility entry point now delegates to `npm run check`, so it cannot keep using a stale hard-coded release version.

## Railway deployment

Railway deploys the application with:

```bash
npm start
```

`npm start` launches `server.js`, which prepares the database schema before it accepts requests. Railway checks `/api/health` during deployment (ready only when the database and schema are).

### Resend invoice email

1. Add the shop's sending domain in Resend and publish the exact SPF and DKIM records shown there. Add DMARC as recommended, then wait for **Verified**.
2. Create a sending-only Resend API key and store it in Railway as `RESEND_API_KEY`.
3. Set `INVOICE_FROM_EMAIL` to a friendly sender on that verified domain, for example `Iron Team Truck & Trailer Repair <invoices@your-domain.com>`.
4. Set `INVOICE_REPLY_TO` to the monitored shop inbox. The `SHOP_*` variables in `.env.example` control the PDF and email branding.
5. Deploy normally without resetting PostgreSQL. Startup creates the additive `invoice_email_deliveries` audit table if needed.
6. Send one invoice to a shop-controlled mailbox and confirm the branded message, payment button, and PDF attachment before sending to customers.

Never commit the Resend API key or a production `.env` file.
