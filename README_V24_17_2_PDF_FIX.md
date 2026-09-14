# ITTR v24.17.2 — Labor-First PDF Fix

This release fixes the actual downloaded invoice PDF endpoint.

## Fixed
- Removed old job/service headings such as "Brake change" from the PDF.
- PDF now uses the labor description as the primary dark row.
- Parts are printed directly beneath the labor they belong to.
- Existing legacy `job_name` values remain only as internal compatibility metadata.
- Redesigned the real server-generated PDF (not only browser print CSS).
- Added Bill To, invoice metadata, vehicle strip, labor/parts hierarchy, customer notes, and totals panels.
- Moved the footer safely inside the printable page area to prevent blank overflow pages.
- Preserved v24.17.1 invoice-tab and full-function audit fixes.

## Validation
- `npm run check`
- `node --check server.js`
