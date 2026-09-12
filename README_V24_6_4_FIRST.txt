ITTR v24.6.4 — LABOR-CENTRIC INVOICE JOBS

Purpose
- Rebuild invoice entry around repair operations, not flat charge rows.
- Every repair starts with LABOR.
- Parts, sublet and fees are attached beneath the specific labor operation they belong to.
- A new labor operation starts the next repair/job.

Workflow
1. Open/create invoice.
2. Click + New Labor and name the service/job.
3. Enter labor description, hours and labor rate.
4. Inside that labor operation click + Part / + Sublet / + Fee only when needed.
5. Click + New Labor for the next repair operation.

Automation
- Work Order -> Service Order -> Invoice creates one labor operation for every repair task.
- Existing task parts are attached to that task's labor operation automatically.
- Labor operations are created even when recorded hours are 0 so the invoice structure remains correct and editable.
- Existing older invoice parts are backfilled to the closest matching labor operation when possible.

Safety
- Non-destructive ALTER TABLE only. No reset.
- Same Railway project/PostgreSQL database.
- Deleting a labor operation also deletes only its attached invoice charges, inside one transaction.
- Changing a labor job name propagates to its attached child charges.
