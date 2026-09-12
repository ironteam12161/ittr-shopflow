ITTR v24.5.2 — RESPONSIVE UI STABILITY

1. Deploy over the SAME Railway project/service.
2. Keep the SAME PostgreSQL database and all existing Railway Variables.
3. Do NOT reset the database.
4. Do NOT re-import Fullbay just for this update.
5. After deployment use Ctrl+Shift+R on desktop and fully refresh/reopen on mobile.
6. Verify the green release bar and /api/build both report 24.5.2.

Quick validation:
- Desktop Work Orders: no "More" panel should appear under the page.
- Desktop Findings: no "More" panel should appear under the page.
- Mobile bottom navigation: Home / Work / Customers / Parts / More.
- Mobile More button: opens a bottom sheet overlay; closes normally; never becomes page content.
- Work Order -> Scan Part: scanner remains above the WO.
- Parts -> Receive Vendor Invoice and Inventory Count remain functional.
