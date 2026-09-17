# ITTR ShopFlow v24.24.5 — Samsara Production Fix

- Corrects Samsara unit/customer join to the actual `fullbay_import_customers.customer_name` schema.
- Normalizes `SAMSARA_API_TOKEN` safely (trims whitespace, surrounding quotes, accidental `Bearer ` prefix).
- Keeps the token secret: diagnostics expose presence/status only, never the value.
- Separates HTTP 401 invalid-token errors from HTTP 403 missing Read Vehicles permission.
- Preserves VIN-first matching, unambiguous unit-number fallback, no automatic duplicate customer/unit creation.
- Preserves database data and the Fullbay inventory `$22` regression guard.
