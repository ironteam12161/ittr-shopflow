ITTR v24.6.1 — SMART SERVICE ORDER + INVOICE WORKFLOW

Deploy over the SAME Railway project and SAME PostgreSQL database.
Do NOT reset PostgreSQL. Do NOT re-import Fullbay.

Primary workflow:
1. Completed Work Order -> Review Service Order / Invoice.
2. Review each job, mechanic clocked time, scanned parts, vehicle and mileage.
3. If completed mechanic time needs correction, use Adjust and enter a required reason. Original clocked time is preserved in the audit trail.
4. Convert Service Order -> Invoice. Customer, unit, VIN, mileage, PO, jobs, adjusted labor hours and parts transfer automatically.
5. Review prices/tax -> Finalize -> PDF/payment.

Manual invoice:
Invoices -> + New Invoice -> search Unit, customer, VIN, plate or DOT -> select vehicle -> ITTR shows last mileage and last service -> Create Draft Invoice.
