ITTR v24.5.3 — SMART RECEIVING EDITOR + SERVER FIX

DEPLOYMENT
1. Deploy over the SAME Railway service/project.
2. Keep the SAME PostgreSQL database and all current environment variables.
3. Do NOT reset PostgreSQL and do NOT re-import Fullbay.
4. After Railway deploys, hard refresh the browser.
5. Verify /api/build reports frontendExpected 24.5.3 and backend 24.5.3.

FIRST TESTS
- Parts > Receive Vendor Invoice > scan/upload invoice.
- Remove one unwanted AI line.
- Add one missing line manually and enter part number, description, qty and buy price.
- Match it to an existing part or leave Create New enabled.
- Press Receive Inventory.
- New part creation must no longer fail with “require is not defined”.
