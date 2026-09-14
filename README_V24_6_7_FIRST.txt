ITTR v24.6.7 — Release Consistency + Invoice Workspace Audit

This release is built directly from v24.6.6 and fixes the production VERSION MISMATCH banner caused by a stale FRONTEND_VERSION constant.

Deploy the COMPLETE release over the same Railway project. Do not reset PostgreSQL and do not re-import Fullbay.

After deployment:
1. Hard refresh the browser (Ctrl+Shift+R).
2. Confirm the green bar reports frontend 24.6.7 / backend 24.6.7.
3. Open one draft invoice.
4. Verify Labor 1 rate preset + numeric amount are one combined control.
5. Change Labor 1 rate, add Labor 2, and confirm Labor 2 inherits Labor 1.
6. Override Labor 2, add Labor 3, and confirm Labor 3 still inherits Labor 1 rather than Labor 2.
7. Type a part number or description and confirm inventory suggestions show full part #, description, selling price and availability.
8. Add a part after typing unsaved labor/header values and confirm values remain.
9. Enter or refresh Illinois tax rate and confirm live tax/total changes before save.

No destructive migrations are included.
