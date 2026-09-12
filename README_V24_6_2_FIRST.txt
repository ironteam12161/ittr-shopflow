ITTR v24.6.2 — PROFESSIONAL INVOICE LINE ENTRY

Deploy over the SAME Railway project and SAME PostgreSQL database.
DO NOT reset PostgreSQL.
DO NOT re-import Fullbay.

After deploy:
1. Hard refresh the browser.
2. Confirm frontend/backend both show 24.6.2.
3. Open Invoices and a draft invoice.
4. Test + Add Line -> Labor.
5. Test + Add Line -> Part.
6. Verify visible labels: Hours/Qty, Labor Rate/Unit Price, Internal Cost, Amount, Tax.
7. Verify Parts only show the Part # field.
8. Test quick + Labor / + Part inside an existing service group.
9. Save Changes, reopen invoice, verify persistence.
10. Test PDF before using on a live customer invoice.
