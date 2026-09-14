# ITTR v24.17.0 — Labor + Parts Invoice

This release removes the visible "service" concept from invoice entry and printing.

## Invoice workflow
1. Add Labor.
2. Enter the labor description, hours, and rate.
3. Add Parts directly under that labor.
4. Repeat for each labor job.

Existing backend job/service identifiers remain internally for compatibility with older invoices,
but the employee-facing invoice interface is labor-first.

## Print / PDF
The print layout was redesigned for a cleaner professional invoice:
- prominent shop name and invoice number
- Bill To and invoice terms panels
- vehicle/unit/VIN/mileage/DOT-PO strip
- each labor job is a dark header row
- parts used for that labor are nested directly underneath
- clear labor/parts subtotals and invoice totals
- customer notes separated from internal notes
- print controls and edit-only fields are hidden

## Validation
Run `npm run check` and `node --check server.js`.
