ITTR v24.3.0 — Parts & Barcode Inventory

Deploy over the SAME Railway project and SAME PostgreSQL database.
Do not reset PostgreSQL. Do not re-import Fullbay.
Railway will install the added bwip-js dependency automatically.

After deploy: hard refresh Ctrl+Shift+R and verify frontend/backend 24.3.0.
Open Parts from the main navigation. Existing Fullbay inventory becomes the starting ITTR parts catalog.

Barcode scanner:
- ITTR generates Code 128 internal labels (ITTR-P-######).
- USB/Bluetooth scanners work through the barcode input.
- Live camera scanning uses the browser BarcodeDetector API when supported.
- Unsupported browsers still have scanner-gun/manual entry fallback.
