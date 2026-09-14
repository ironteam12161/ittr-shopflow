ITTR ShopFlow v24.15.0 — Dedicated Invoice Workspace + Inventory Part Search

WHAT CHANGED
- Invoice Open buttons launch a dedicated browser invoice workspace instead of squeezing the editor into the normal ShopFlow shell.
- The invoice workspace hides normal navigation/header and uses the full viewport.
- Part # and Description fields now search live ITTR inventory after 2 characters.
- Selecting a result fills part number, description, cost, selling price and taxable flag.
- Search results show selling price, cost, available quantity and location.
- Existing service -> parts -> labor workflow and labor rate presets are preserved.

DEPLOYMENT
Deploy over the SAME Railway service and SAME PostgreSQL database. Do not reset or recreate the database.
Run npm install then npm run check before deployment.

SMOKE TEST
1. Open Invoices in main ShopFlow.
2. Click Open on an invoice; verify a separate full-page invoice workspace opens.
3. Add Part under a service, type two letters from an inventory description (example: oil).
4. Verify matching inventory appears and selecting it fills part #, description, cost and selling price.
5. Save, close the invoice workspace, reopen, and confirm values persist.
6. Verify PDF/Print, payment, void and owner delete still work.
