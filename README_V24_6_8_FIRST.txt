ITTR v24.6.8 — Job View Invoice UX

This release is built from v24.6.7 and redesigns the invoice editor around a compact labor-first Job View pattern.

Deploy the COMPLETE ZIP over the same Railway project. Do not reset PostgreSQL and do not re-import Fullbay.

After deployment:
1. Hard refresh (Ctrl+Shift+R).
2. Confirm frontend 24.6.8 / backend 24.6.8.
3. Open a draft invoice.
4. Confirm every repair is one clean labor/job card with attached parts directly beneath it.
5. Confirm the labor rate plan and $/hr fields are fully visible.
6. Add a part and verify unsaved labor/header values are preserved.
7. Search a part by number or description and select from inventory suggestions.
8. Add Labor 2 and verify it inherits Labor 1 rate; override Labor 2 and add Labor 3 to confirm Labor 3 still inherits Labor 1.
9. Verify Illinois tax/live totals and Save Changes.
10. Confirm sent/partial invoices remain editable; invoices without payments can be deleted.

No destructive migrations are included.
