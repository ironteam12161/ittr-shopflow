# ITTR ShopFlow v24.18.2 — Customer Print Layout Fix

Fixes the browser Print/PDF invoice presentation reported in v24.18.1.

- Replaces conflicting historical print headers with one dedicated 5-column customer header: TYPE / DESCRIPTION / QTY-HRS / RATE-PRICE / AMOUNT.
- Labor and parts use identical print column boundaries.
- Removes duplicated RATE / PRICE and AMOUNT labels.
- Hides empty draft part rows from customer print/PDF.
- Collapses empty customer Notes instead of reserving a large blank box.
- Tightens totals, warranty, safety notice, and signature layout.
- Keeps internal Cost / Markup / Tax / Discount / Actions out of customer print output.
- Server-generated PDF filters empty placeholder lines.
- No database migration required.
