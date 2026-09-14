# ITTR ShopFlow v24.17.5 — Workshop AI PM History Fix

This release fixes Workshop Copilot history retrieval so newly-created ITTR PM/service invoices are not skipped in favor of older imported Fullbay history.

Changes:
- Groups current ITTR invoice lines into invoice-level service records before sending context to AI.
- Treats draft, sent, partial, and paid ITTR invoices as visible shop history, while preserving their status.
- Adds semantic PM/oil/filter/lube/grease matching across ITTR invoices, ITTR work orders, and Fullbay history.
- Prioritizes the newest matching ITTR PM record ahead of older Fullbay records.
- Adds a deterministic safeguard: if the AI response omits the newest matching ITTR PM invoice, the server prepends the exact database-backed record.
- Expands recent ITTR work-order context and keeps invoice ordering stable by invoice date and update time.
- Preserves the v24.17.4 invoice fees, warranty, tire re-torque notice, PDF, autosave, and security hardening changes.

Validation:
Run `npm run check`.
