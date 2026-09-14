ITTR v24.7.1
Deploy over the SAME Railway project and SAME PostgreSQL database.
DO NOT reset the database and DO NOT re-import Fullbay.

After deploy:
1. Hard refresh.
2. Confirm green bar/frontend and /api/build are 24.7.1.
3. Open Customers & Vehicles -> Air Delivery -> Unit 6600.
4. Confirm Customer Profile no longer throws jobHistoryCount is not defined.
5. Open Service History and search a repair name (PM SERVICE, ALIGNMENT, etc.).
6. Open an ITTR invoice history row and confirm the invoice opens.
7. Open a Fullbay SO history row and confirm the grouped service order opens.
8. Smoke-test Work Orders, Findings, Parts scan, Smart Receiving, Inventory Count, Invoices/PDF.
