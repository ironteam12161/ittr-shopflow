# ITTR ShopFlow v24.19.0 — Customers/Units + Repair Orders Import

Adds reusable Fullbay Data Center importers for CustomersUnits.csv and repairOrders.csv.

Recommended order:
1. Import Customers + Units.
2. Import Repair Orders.

Safety:
- Repeat imports are idempotent. Customers/units match by Fullbay IDs, VIN, and customer/unit relationship.
- Repair orders use original SO number as stable source key and update on repeat import.
- Existing PostgreSQL data is not reset.
- Fullbay inventory v23.7.1 $22 parameter regression guard remains intact.

Repair order fields preserved include SO, service writer, invoiced status, PO number, unit, lead tech, customer, complaint, severity, service status, parts status, total, notes count, completed date, and unit return. Original CSV row is also retained in raw JSON.
