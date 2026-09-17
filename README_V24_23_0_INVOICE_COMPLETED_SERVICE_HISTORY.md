# ITTR v24.24.0 — Invoice → Completed Unit Service History

Every non-void ITTR invoice linked to a unit is represented in Unit Service History as a completed service visit, while retaining the separate billing status (Draft/Sent/Partial/Paid).

Opening the history record now shows a read-only service-detail view similar to imported Fullbay service orders:
- customer / unit / VIN / mileage / completion date
- invoice number and billing status
- each labor job
- parts grouped beneath the labor job they belong to
- part number, description, quantity, selling price and line total
- labor hours/rate/total
- other charges / fees and invoice total

Service history itself is not editable. Corrections are made only through `Edit Original Invoice`, so there is one billing/service source of truth.

No DB reset and no schema migration.
