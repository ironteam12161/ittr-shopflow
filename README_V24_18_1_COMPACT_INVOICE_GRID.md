# ITTR ShopFlow v24.18.1 — Compact Invoice Grid

## Invoice editor polish
- Corrected the desktop invoice grid from an inconsistent nine-column layout to a true ten-column layout matching Type, Description, Qty/Hrs, Cost, Markup, Price/Rate, Tax, Discount, Line Total, and Actions.
- Reduced editable control height to 32px on desktop and body typography to 11–12px for denser shop billing.
- Kept Part # and Description on one aligned line.
- Markup percent remains inline next to the markup field instead of wrapping below it.
- Labor rate selector spans Cost/Markup/Price columns so labor and part rows line up under one header.
- Tax checkbox, discount, total, and action menu now stay on the same row.
- Added an additional compact layout for 1101–1380px desktop widths.
- No database migration.

Run `npm run check` before deployment. Deploy over the same Railway service/database.
