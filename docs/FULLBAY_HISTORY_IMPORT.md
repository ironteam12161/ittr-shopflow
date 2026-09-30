# Moving truck repair history from Fullbay to ShopFlow

ShopFlow already imports Fullbay exports. Re-running an import updates existing records instead of duplicating them, so it is safe to repeat.

## 1. Export from Fullbay (CSV)

| File | Where in Fullbay | What it brings in |
|---|---|---|
| **CustomersUnits.csv** | Customers → export customers with units | Customers, units, VINs |
| **Details / Service History** | Reports → *Service Order Details* (a.k.a. "Details") → Export CSV. Pick the widest date range available. | Every job line: Customer, Unit #, SO, Complaint, Actual Correction, hours, labor, parts, techs, mileage |
| **repairOrders.csv** | Reports → Repair Orders → Export CSV | SO-level totals, invoice numbers, dates |
| Customers / Parts (optional) | Customers export, Inventory export | Customer details, parts inventory |

The Details export must contain at least these columns: `Customer`, `Unit #`, `SO`, `Complaint`, `Actual Correction`.

If Fullbay only allows a limited date range per export, export year by year and import each file in turn. The files may be up to **80 MB each**.

## 2. Import into ShopFlow, in this order

Go to **Operations → Fullbay & Samsara**, then:

1. **Import Customers + Units** → CustomersUnits.csv
2. **Import Units + Service History** → the Details export (one file per year is fine)
3. **Import Repair Orders** → repairOrders.csv
4. **Audit / Repair History Links**. This connects history rows to the right customer and unit.
5. **Decode Missing VIN Details** (optional). This fills in year, make and model from NHTSA.

## 3. Check it

Open **Customers & Vehicles**, pick a truck, and open **Service History**. Fullbay jobs show as `SO #…` rows with hours and amounts.

**Operations → Fullbay & Samsara → Imported Service History Cleanup** can find and remove bad imports.

## Tip before going live

Import Fullbay history **after** you use **Operations → Start fresh** to clear test data. "Start fresh" never deletes customers, units or imported Fullbay history.
