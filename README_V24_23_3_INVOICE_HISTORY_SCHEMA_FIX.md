# ITTR v24.24.0 — Invoice Service History Schema Fix

Root cause: the v24.23.0 invoice-history query referenced `customer_invoices.tax_amount`, `additional_fees`, and `other_charges`, but those columns do not exist in the production invoice schema. The profile endpoint catches that SQL error, so Fullbay history continued to display while all ITTR invoice-history rows silently disappeared.

Fix:
- `tax` is exposed as `tax_amount`.
- Additional fees are derived from `shop_supplies + environmental_fee`.
- Other charges remain derived from invoice line type `other`; no nonexistent invoice header column is queried.
- All non-void invoices (draft, sent, partial, paid) remain eligible for unit service history.
- Read-only completed-service detail + Edit Original Invoice behavior is preserved.
- No DB reset or migration.
