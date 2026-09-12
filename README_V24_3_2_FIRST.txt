ITTR v24.3.2 — Mobile Nested Scanner Stack Fix

Deploy this package over the SAME Railway project/database.
Do not reset PostgreSQL. Do not re-import Fullbay.

After deployment:
1. Hard refresh the browser (Ctrl+Shift+R on desktop; fully close/reopen or refresh on phone).
2. Verify the green bar shows v24.3.2 and backend 24.3.2.
3. On a phone, open an active Work Order and tap Scan Part inside a task.
4. Barcode Scanner must open above the Work Order immediately.
5. Closing the scanner must return to the still-open Work Order.

See V24_3_2_MOBILE_SCANNER_AUDIT.txt for the full technical audit.
