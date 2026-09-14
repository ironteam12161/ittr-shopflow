# ITTR ShopFlow v24.17.4 — Invoice Fees, Warranty & Tire Safety

Release date: 2026-09-14

## What changed

- Invoice summary now separates Labor, Parts, Other Charges, and Additional Fees.
- Additional Fees represent Shop Supplies + Environmental / Other Fee and update live.
- Fixed a preview bug where non-part charges could be counted inside Labor Subtotal.
- Shop Supplies, Environmental / Other Fee, tax, and discount controls now autosave while editing.
- Server-generated PDF now shows Shop Supplies and Environmental / Other Fee in the totals breakdown.
- Attached non-labor rows are labeled under "PARTS & CHARGES FOR THIS LABOR" in the PDF.
- Added a permanent customer-facing Parts Warranty notice to the invoice workspace, browser print, server PDF, and invoice email.
- Added a permanent Tire / Wheel Safety notice requiring wheel fasteners / lug nuts to be checked and re-torqued after approximately 50 miles of driving.
- Health/build/startup version markers are synchronized to 24.17.4.

## Standard invoice notice

PARTS WARRANTY: We are responsible for handling eligible warranty claims on parts supplied and installed by Iron Team Truck & Trailer Repair, subject to the applicable manufacturer warranty and shop terms.

TIRE / WHEEL SAFETY: After tire or wheel service, wheel fasteners / lug nuts must be checked and re-torqued after approximately 50 miles of driving. Please return to our shop for this safety check. Stop driving and have the vehicle inspected if looseness, vibration, noise, or any abnormal condition is noticed.

## Validation

- `npm run check`: 169/169 checks passed.
- `node --check server.js`: included in the release check.
- Root/public invoice frontend copies are byte-identical.
- Root/public invoice module JS and HTML copies are byte-identical.
- Regression checks cover invoice autosave, PDF draft persistence, fee display, warranty notice, tire notice, one-tab invoice behavior, inventory lookup, manager/manual functions, route duplication, permissions, and core system functions.
