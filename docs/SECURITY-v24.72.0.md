# ITTR ShopFlow v24.72.0 — fixes for the October 17, 2026 audit

Baseline: v24.71.1, commit `4585d0e5ec564b465b1ebff4f666baaec7c4c45f`. Each finding was reproduced against that code
with the new `integrity_integration_test.mjs` (real server, throw-away database): on the baseline 6 of its 8 scenarios
fail (the two that pass check that normal work still saves); all 8 pass now. Production was not contacted or changed.

| ID | Finding | Status | What changed |
|---|---|---|---|
| F1 | Mechanic whole-shop save could rewrite finished work | Fixed | `PUT /api/state/shopflow` (mechanic): a Completed/Invoiced/Closed work order is not changed; no existing job is removed; parts and timer fields only change through their own routes; a job another mechanic finished stays as it is; a completed inspection is final. What was refused comes back as `notApplied` and the phone shows "Not saved: … ask the office to reopen it"; it is also written to the audit log. Normal edits (job outcome, notes, new job, finishing the order) still save. |
| F2 | Customers permission exposed invoices another way | Fixed | Creating a customer portal link needs Invoices as well as Customers. Without Invoices, customer and vehicle profiles leave out shop invoices and remove invoice numbers and amounts from Fullbay history, and the Fullbay service-order detail drops invoice/amount fields. |
| F3 | Repeated PO receipt line received twice | Fixed | A line listed twice is refused (whole receipt rolled back); the running received amount is tracked; the update itself refuses to go over the ordered quantity. |
| F4 | Startup merged and deleted same-name customers | Fixed | Startup only counts same-name groups and logs them. The owner's reviewed merge (Customers → duplicate audit, with preview) now also moves estimates, portal links, payments/credits, inspection documents, text messages and work orders in the same transaction, and stores the removed record in the audit log. The old automatic merge was removed. |
| D1 | `main` not protected | Not changed (repository setting) | Owner action: protect `main` — require the release check and a review, block force-push and deletion. |
| D2 | CSV uploads unbounded per request | Fixed | 200 MB per upload request (`ITTR_CSV_MAX_REQUEST_MB`), checked before the body is read; one upload per account and 2 at once (`ITTR_CSV_MAX_CONCURRENT`). |

Migration: none. New optional settings: `ITTR_CSV_MAX_REQUEST_MB`, `ITTR_CSV_MAX_CONCURRENT`. Rollback: redeploy v24.71.1
(note that v24.71.1 would merge same-name customers again on its next start).

Existing data to review (read-only first): purchase-order lines where `qty_received > qty_ordered`, and customers that may
already have been merged by name on earlier starts (`server_audit` has no record of those older automatic merges).
