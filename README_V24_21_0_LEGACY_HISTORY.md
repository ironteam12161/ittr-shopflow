# ITTR ShopFlow v24.22.4 — Legacy Fullbay History Copilot

## What changed
- AI screenshot/PDF imports now default to **Completed History**, not billing.
- Review action: **Add to Completed History**.
- Draft invoice remains an explicit secondary option.
- Fullbay Service Order/SO is preferred as the source identity.
- AI-imported service rows preserve labor and individual parts in history raw detail.
- Service Order detail view exposes AI-imported parts/labor.
- Fullbay Data Center adds **Audit / Repair History Links**.
- History reconciliation relinks orphan history to existing customers/units without deleting records.
- Service-order lookup normalizes `SO-1234`, `1234`, and `(Quick SO)` variants.

## Audit of the prior CSVs
CustomersUnits.csv: 122 rows. It contains 25 nonblank VIN/serial values that are not valid 17-character VINs and one duplicate customer+unit-number group (BT XPRESS INC / unit 297). These are flagged, not automatically deleted.
repairOrders.csv: 79 summary repair orders.
details.csv: 2,064 detailed Fullbay service-action rows. This is the file that contains Complaint / Actual Correction / Hours / Labor / Parts by action and should remain the primary detailed historical source.

No database reset. No destructive cleanup.
