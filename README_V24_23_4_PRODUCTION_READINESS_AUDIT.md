# ITTR v24.24.0 — Production Readiness / Service History Open Fix

## Confirmed root cause
The v24.23.0 invoice-history modal was accidentally injected before the first literal `</body>` in index.html. That `</body>` belonged to the invoice print-window HTML template inside JavaScript, not the live application document. Therefore the live page had no `invoiceHistoryDetailTitle`, `invoiceHistoryDetailBody`, or `invoiceHistoryDetailModal`. Clicking an ITTR invoice history row attempted to set `.textContent` on null and produced the exact production error shown in the screenshot.

## Fix
- Moved invoice history modal into the real application DOM, after the final script and before the real closing body.
- Added a defensive DOM guard so a missing modal can no longer crash the app.
- Preserved invoice → completed service history and Edit Original Invoice source-of-truth workflow.
- Re-audited work-order open/detail modals, vehicle profile, invoice history, route modules, parts module, Samsara, Fullbay cleanup, barcode aliases, and the Fullbay inventory `$22` regression guard.
- No database reset or schema migration.
