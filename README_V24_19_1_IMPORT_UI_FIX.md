# ITTR ShopFlow v24.19.1

Corrective release for the Fullbay Data Center import UI.

- Customers + Units and Repair Orders inputs are in the actual lazy-loaded ProCenter module.
- Lazy module URLs are versioned with `?v=24.19.1`.
- Module HTML is fetched with `cache: no-store`.
- Express sends no-store/no-cache headers for module assets.
- Import cards clearly show which file goes where and the required order.

Import `CustomersUnits.csv` first, then `repairOrders.csv`.
Both importers use update/upsert behavior and are safe to repeat.
Do not reset PostgreSQL.
