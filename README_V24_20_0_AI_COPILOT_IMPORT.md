# ITTR ShopFlow v24.24.4 — AI Copilot + Intelligent Import

Workshop AI is upgraded from Q&A into a controlled ShopFlow Copilot.

## New
- Attach JPG/PNG/WEBP/PDF legacy invoices/service orders directly in Workshop AI.
- AI extracts customer, unit, VIN, dates, terms, source number, labor, parts, quantities, rates, taxable flags and totals.
- AI groups parts under the service/labor operation above them.
- ITTR matches extracted customer/unit and searches inventory for detected parts.
- Review-first workflow: nothing is posted until **Create Draft Invoice** is confirmed.
- Draft invoice is created in ITTR and opened for normal review/editing before finalization.
- CSV attachments route to the safe Fullbay Data Center import workflow for Customers + Units or Repair Orders.
- Controlled Copilot navigation commands: invoices, parts/inventory, customers, work orders.
- Diagnostic intent can run a safe server/database/Copilot health snapshot.
- AI import actions are audit logged.

## Security / accounting
- No AI-created invoice is finalized automatically.
- Unreadable values must be blank/warned, not invented.
- Existing invoice permissions are enforced on AI import routes.
- Existing Fullbay, invoice, mechanic, manager, print/PDF and inventory protections are preserved.
