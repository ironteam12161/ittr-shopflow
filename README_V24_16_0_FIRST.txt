ITTR ShopFlow v24.16.0 — Invoice Tab + Draft Preservation Audit

DEPLOYMENT
- Deploy over the SAME Railway service and SAME PostgreSQL database.
- Do NOT reset, recreate, or wipe PostgreSQL.
- No destructive schema migration is required for this release.

PRIMARY FIXES
1. Restored renderMechanicAccounts() to eliminate the startup App error regression.
2. Invoice Open uses a normal _blank browser tab without popup sizing/features.
3. Add Part / Add Labor / Add Misc Charge / Add Service silently persist the current invoice draft before changing the invoice structure.
4. Saving one row no longer wipes unsaved sibling rows.
5. Deleting a line also preserves other unsaved edits first.
6. Parts autocomplete remains connected to /api/parts and fills part number, description, cost, sell price and taxable status.
7. Invoice workspace UI adds an explicit draft-state badge and cleaner compact service rows.

SMOKE TEST
- Login as admin: no App error banner.
- Invoices > Open: invoice opens in a normal new browser tab.
- Type labor description/hours/rate but do not press Save, then Add Part: prior values must remain.
- Type a part search (e.g. oil): inventory suggestions must appear.
- Select inventory part: part #, description, cost and selling price populate.
- Edit two rows, press Save on one: both edits must remain.
- Print/PDF, finalize, payment link, email, void and permanent delete should continue to work.
