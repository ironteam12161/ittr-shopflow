ITTR v24.5.1 — Parts Receiving + Barcode + Physical Inventory Audit

DEPLOYMENT
1. Deploy these files over the SAME Railway application.
2. Keep the SAME PostgreSQL database and existing Railway variables.
3. Do NOT reset PostgreSQL and do NOT re-import Fullbay.
4. After Railway redeploys, hard-refresh the browser/phone.
5. Verify frontend 24.5.1 and backend 24.5.1 in the green status bar.

FIRST TESTS
A. Parts -> Receive Vendor Invoice -> analyze one invoice -> Receive Inventory.
   If receiving fails, the review now shows the exact receiving stage/error and no partial stock is committed.
B. Parts -> open a part -> Scan Manufacturer Barcode. Scan the manufacturer's UPC/EAN/Code128 and save it as an alias.
C. Parts -> Inventory Count. Choose:
   - Scan Each Item: every scan increments physical quantity by one.
   - Scan Shelf / Bin: scan a SKU once and type the physical quantity.
D. Try an unknown manufacturer barcode during inventory count. Search/select the existing part, assign the barcode, then continue counting.
E. Review & Apply only after the physical count is correct.

SAFETY
Inventory-count completion refuses to overwrite a part whose live stock changed after it was counted. Recheck that item first. Only scanned/reviewed items are adjusted; unscanned inventory is untouched.
