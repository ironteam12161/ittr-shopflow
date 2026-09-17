# ITTR ShopFlow

Production shop-management PWA for **Iron Team Truck & Trailer Repair**.

## Current production line

**v24.24.x** — Work orders, invoicing, customer/unit service history, parts and barcode inventory, Smart Vendor Receiving, mechanic workflows, AI assistance, Fullbay data tools, Samsara integration, offline/PWA support, and role-based administration.

## Repository layout

- `public/` — production browser/PWA assets and route modules served to users.
- `modules/` — canonical mirrored route modules used by the current build/release checks.
- `assets/` — application branding/assets.
- `database/` — database-related project files.
- `server.js` — Express/PostgreSQL backend and API routes.
- `schema.sql` + numbered `*.sql` files — schema/migration history. **Never reset production PostgreSQL when deploying.**
- `package.json` — Node runtime and scripts.
- `railway.json` / `Procfile` — Railway deployment configuration.
- `release_audit.mjs` — current regression/release audit.
- `.env.example` — environment-variable template; real secrets must never be committed.

## Production rules

1. Deploy from `main` only after release checks pass.
2. Do not commit `node_modules`, `.env`, ZIP packages, temporary files, browser-renamed duplicates such as `parts (4).html`, or old backup copies.
3. Keep the Fullbay inventory-import PostgreSQL parameter fix intact; do not regress the guarded import query.
4. Do not reset or recreate the Railway PostgreSQL database during application deployments.
5. Treat `public/modules/` as production UI code. Avoid placing alternate module copies at repository root.
6. Keep version identifiers consistent across frontend, backend `/api/build`, package metadata, PWA cache/version markers, and release audits.

## Main product areas

**Operations:** Dashboard, Work Orders, Findings, mechanic time/activity and completed work.

**Customers & Vehicles:** Customer/unit directory, VIN/USDOT data and unified service history.

**Finance:** Labor-centric invoicing, work-order sync, parts/fees/discounts, payments, PDF/print and invoice service-history records.

**Parts:** Inventory, manufacturer/internal barcode scanning, physical inventory and Smart Vendor Receiving.

**Integrations & AI:** Fullbay import/history tools, Samsara fleet data and Workshop AI.

## Local validation

Run the repository's normal checks before deployment:

```bash
npm run check
node --check server.js
node release_audit.mjs
```

Railway starts the application with `node server.js`.
