# ITTR ShopFlow

Production shop-management PWA for **Iron Team Truck & Trailer Repair**.

## Current production line

**v24.28.x** — Work orders, invoicing, customer/unit service history, parts and barcode inventory, Smart Vendor Receiving, mechanic workflows, AI assistance, Fullbay data tools, Samsara integration, offline/PWA support, multilingual mechanic UI, and role-based administration.

## Repository layout

- `public/` — production browser/PWA assets and route modules served to users.
- `modules/` — canonical mirrored route modules used by the current build/release checks.
- `assets/` — application branding/assets.
- `database/` — database-related project files.
- `server.js` — Express/PostgreSQL backend and API routes.
- `schema.sql` + numbered `*.sql` files — schema/migration history. **Never reset production PostgreSQL when deploying.**
- `package.json` — Node runtime and scripts.
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
7. Use the normal startup command (`npm start`) so the required idempotent runtime preparation is applied before `server.js` starts.

## Main product areas

**Operations:** Dashboard, Work Orders, Findings, mechanic time/activity and completed work.

**Customers & Vehicles:** Customer/unit directory, VIN/USDOT data and unified service history.

**Finance:** Labor-centric invoicing, work-order sync, parts/fees/discounts, payments, PDF/print and invoice service-history records.

**Parts:** Inventory, manufacturer/internal barcode scanning, physical inventory and Smart Vendor Receiving.

**Inventory:** reserve on work order, take out of stock on invoice finalize.

**Integrations & AI:** Fullbay import/history tools, Samsara fleet data and Workshop AI.

## Local validation

Install dependencies, then run the same maintained release path used by CI:

```bash
npm run check
```

`npm run check` intentionally runs runtime preparation twice before validation so every runtime patch must remain safe to re-run.

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

`npm start` runs the required runtime preparation and then launches `server.js`. Railway checks `/api/health` during deployment.
