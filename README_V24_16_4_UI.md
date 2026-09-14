# ITTR v24.16.4 — Simplified Invoice Interface

This release keeps the v24.16.3 functionality, autosave protections, security hardening,
parts-search performance improvements, and invoice-grid fixes while simplifying the invoice workspace.

## Interface changes
- Renamed "Repair Services" to "Services & Parts".
- Reworded instructions in plain shop language.
- Clearer invoice columns: Type, Work / Part Description, Qty / Hrs, Cost, Price / Rate,
  Tax, Discount, Line Total, Actions.
- Simplified service actions to Add Part, Add Labor, and Other Charge.
- Removed the duplicated bottom action bar from the visible UI.
- Service totals and subtotals have stronger visual hierarchy.
- Customer and internal notes are grouped into a clearer Notes section, with visible/customer
  and shop-only indicators.
- Inputs have consistent sizing, focus states, spacing, and responsive behavior.
- Existing underlying invoice actions and autosave behavior are preserved.

## Validation
Run:
    npm run check
and:
    node --check server.js
