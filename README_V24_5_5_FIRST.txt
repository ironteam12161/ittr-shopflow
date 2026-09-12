ITTR v24.5.5 — PostgreSQL Numeric Typing + Smart Receiving Audit

1. Deploy this package over the SAME Railway service and SAME PostgreSQL database.
2. Do NOT reset PostgreSQL and do NOT re-import Fullbay.
3. Hard refresh after deployment.
4. Verify /api/build reports frontend/backend 24.5.5.
5. Retest Parts -> Receive Vendor Invoice -> Receive Inventory.

Primary production fix:
- The line_N_stock failure "operator is not unique" was traced to PostgreSQL trying to resolve arithmetic between untyped bind parameters in inventory_value=$2*$4.
- All stock-value arithmetic now uses explicit ::numeric casts, including Smart Receiving, physical inventory count, manual inventory transactions, Work Order part consumption, and Work Order part returns.
- Smart Receiving numeric/text/boolean bind parameters are explicitly typed across invoice header, invoice lines, new-part creation, stock update, and cost-history writes.

No destructive migration is included.
