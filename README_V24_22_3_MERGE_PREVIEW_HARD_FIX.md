# ITTR v24.24.3 — Merge Preview Hard Fix

The duplicate scan works, but production showed the Review Merge endpoint still returned HTTP 500.
This release removes the fragile array-based preview query and counts each customer independently.
Optional invoice/service-order tables are checked with PostgreSQL `to_regclass()` before preview or merge.
If preview ever fails again, the UI receives the exact stage (load customers / count master / count duplicate) instead of a generic server error.

No database reset. No schema migration. Existing Fullbay history, invoice, AI, Samsara and inventory behavior is preserved.
