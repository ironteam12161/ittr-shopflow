# ITTR ShopFlow v24.23.3 — Invoice Layout + Print Fix

Fixes the invoice regression shown in production:
- lazy-loaded invoice CSS is promoted into document `<head>` so it cannot disappear when route DOM changes;
- desktop Labor & Parts rows remain on the accounting grid instead of collapsing into raw stacked controls;
- isolated invoice tabs retain the same invoice CSS;
- print/PDF is forced into a customer-only layout and no longer prints the editable Billing Information form as blank pages;
- print Labor/Parts rows use one stable five-column customer layout.

No invoice math, pricing, history, AI history import, Fullbay data, or database schema was changed.
No database reset is required.
