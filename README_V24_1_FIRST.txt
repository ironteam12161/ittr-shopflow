ITTR v24.1.0 — FULLBAY DETAILS MIGRATION

This build adds a safe Fullbay Details CSV importer for units and historical service records.

The supplied details.csv was inspected before the importer was built:
- 2,064 detail/action rows
- 1 customer: AIR DELIVERY CORPORATION
- 51 unique Unit # values
- 51 unique VINs
- 547 unique service orders
- 547 unique invoice numbers
- history range: May 2, 2023 through July 31, 2026

How to import after deployment:
1. Operations -> Fullbay Data.
2. Choose Details / Units + Service History CSV.
3. Select details.csv.
4. Click Import Units + Service History.
5. The same file can be imported again safely; matching rows update rather than duplicate.
6. Optional: click Decode Missing VIN Details to use official NHTSA vPIC for year/make/model and available engine/transmission data.

Expected result for the supplied file:
- AIR DELIVERY CORPORATION receives up to 51 linked units (existing matches are updated, not duplicated).
- Customer service history gains 547 Fullbay service orders represented by 2,064 action rows.
- Smart Search searches the imported units, VINs, SO/invoice numbers, complaints and corrections.

No database reset. Existing ITTR work orders, photos, labor sessions, findings and parts are preserved.
