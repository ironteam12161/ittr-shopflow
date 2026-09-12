ITTR v24.3.1 — Parts Interface / Barcode / Label Audit Fix

Deploy over the SAME Railway project and SAME PostgreSQL database.
Do NOT reset PostgreSQL and do NOT re-import Fullbay.

After deploy:
1. Hard refresh with Ctrl+Shift+R.
2. Verify the green bar shows frontend 24.3.1 and backend 24.3.1.
3. Open Parts -> any part.
4. Confirm the barcode renders (not a broken image icon).
5. Print a test 3.5 x 2 label.
6. Test camera scan and USB/Bluetooth scan entry.

This release is data-safe and contains no destructive database reset.
