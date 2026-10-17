# ITTR ShopFlow v24.75.0: mechanic work-order visibility and mechanic audit

**Baseline.** Current `main` is `4585d0e` (v24.71.1). This branch also carries v24.72–v24.74, which are not merged yet.

**Testing.** All verification used isolated test accounts in a throw-away database.

**Production was not contacted.** The live site is blocked from this environment (proxy 403), and no production database credentials are available here. No password, role, assignment or record was read or changed. Roman's and Ivan's real account settings are therefore **not verified**; see "Root cause".

## Root cause of the Roman/Ivan difference

### Verified in code (current `main`)

The server sent each mechanic **only the work orders where they are the primary mechanic or a helper**:

- `shopflowForUser()` filters with `mechanicOwnsWorkOrder()`.
- That check compares lower-cased usernames in `w.mechanic` and `w.helpers`.

The phone then narrowed the list further:

- **Ready** needed the truck to be here.
- **Upcoming** needed it to be on the way.
- **Completed** showed only work they completed or were assigned to.
- `openDetail()` refused anything else.

So two mechanics see different lists whenever their assignments differ. Whoever is assigned (or added as a helper) on more orders sees more. Orders with no mechanic are seen by **no** mechanic.

`mechanic_visibility_integration_test.mjs` reproduces this on `main`:

- Roman sees `801,802,805` instead of all five work orders.
- `803` (assigned to nobody) is invisible to both mechanics.

### Account facts (not verified)

These need a read-only check by the owner. Run in the Railway database console:

```sql
-- Account status and role (no secrets selected)
SELECT username, display_name, role, active, created_at FROM auth_users
 WHERE lower(display_name) LIKE '%roman%' OR lower(display_name) LIKE '%ivan%' OR lower(username) LIKE '%roman%' OR lower(username) LIKE '%ivan%';

-- How many open work orders name each of them as primary / helper, exactly as stored
SELECT w->>'mechanic' AS primary_value, count(*) FROM app_state, jsonb_array_elements(payload->'workorders') w
 WHERE state_key='shopflow' AND w->>'status' <> 'Completed' GROUP BY 1 ORDER BY 2 DESC;
SELECT h AS helper_value, count(*) FROM app_state, jsonb_array_elements(payload->'workorders') w, jsonb_array_elements_text(coalesce(w->'helpers','[]')) h
 WHERE state_key='shopflow' AND w->>'status' <> 'Completed' GROUP BY 1 ORDER BY 2 DESC;
```

What to look for:

- If Ivan's `primary_value` / `helper_value` entries are missing, assignments explain the difference.
- If they are spelled differently from his `username` (for example a display name like "Ivan" instead of `ivan.k`), the case-insensitive comparison still fails. Before this release that hid those work orders from him.

Stale browser state can also hide new work on a phone, but only until the next refresh. Every phone now reloads the shop record on each `shopflow_changed` live signal.

## What changed

| Area | Before | Now |
|---|---|---|
| Mechanic read policy (server) | Assigned work orders only | Every work order of the shop (`mechanicCanViewWorkOrder`). This covers findings, task-time records, photos, the completed work-order PDF, the inspection PDF and the vehicle profile's work list. |
| Mechanic write policy (server) | Assigned only | **Unchanged.** `mechanicOwnsWorkOrder()` still guards timers, parts, inspection answers, helpers, finding approval, completion and whole-shop save edits. A save that changes a work order the mechanic is not on is ignored and reported (`notApplied: not_assigned`). |
| Data in a mechanic's copy | Part buy cost (`unitCost`) was included on their own work orders | Part buy cost is removed from every work order and from the add-part response. Sell price is kept, as in parts search. Invoice/contact keys are removed if present. The server restores them on save. |
| Mechanic directory | Only the mechanic's own entry, so the helper picker said "Every mechanic is already assigned" | Active mechanics as `{role, display}` only. No activity, permissions, contact details or other roles. |
| Mechanic home screen | Ready = assigned + truck here; Upcoming = assigned + on the way | **All shop work** is the default. **My assigned work** is a filter that includes primary and helper assignments. Search covers unit, WO #, customer, mechanic and job. Every open order is in exactly one of Ready or Upcoming, with counts. |
| Cards | Unit only | Unit, **WO #**, stage, primary mechanic, helpers, and an "Assigned to you" / "View only" badge. |
| Completed | Own work only | Every completed work order of the shop. "My assigned work" shows the ones they took part in. |
| Detail | Refused for unassigned work | Opens for every mechanic. Action buttons appear only when assigned. Otherwise it shows "View only…". The title shows the WO number. |
| Reopen ("Reactivate / Add Missed Work") | Went through the whole-shop save. The v24.72.0 completed-record lock now refuses that silently. | Dedicated `POST /api/work-orders/:id/reactivate` with the same rule (completing or primary mechanic, or office). A reason and at least one job are required, and it is recorded in history and the audit log. |
| Workshop AI | `work_orders` / `work_order_details` limited to the mechanic's own work | The same read policy as the app. Money stays hidden as before. |
| Account switching | Filter and search could persist in the page | The filter is remembered per account. Search resets on sign-in, and the state belongs to the signed-in account (S5 cleanup). |

## Mechanic capability matrix

The server enforces every row.

| Capability | All active mechanics | Assigned mechanic (primary/helper) only | Restricted (office/owner) |
|---|---|---|---|
| See work orders, jobs, notes, inspection results, findings, photos, task-time records, completed WO PDF, inspection PDF | ✓ | | |
| Search / filter / Completed history | ✓ | | |
| Start, pause, resume or finish a job timer; record outcomes | | ✓ | |
| Add or remove parts on a job | | ✓ | |
| Inspection answers, add finding from inspection, upload finding photos | | ✓ | |
| Edit or delete a photo | | uploader | owner |
| Add a helper | | ✓ (not on completed) | |
| Remove a helper | | primary mechanic | ✓ |
| Change the primary mechanic, priority, parking, QC, blockers, release | | | ✓ |
| Complete a work order | | ✓ | ✓ |
| Reopen a completed work order | | completing or primary mechanic | ✓ |
| Change completed work (jobs, notes, inspection) through the whole-shop save | ✗ | ✗ | ✓ |
| Approve or decline findings, customer links, estimates, invoices, payments, bills, purchase orders | | | ✓ (by permission) |
| Part buy costs, inventory value, customer contact details, other accounts' data, users record | ✗ | ✗ | ✓ (by permission) |
| Clock in/out, own activity | own account | | admin edits |

## Audit findings (mechanic scope)

| # | Severity | Finding | Reproduction | Status |
|---|---|---|---|---|
| M1 | High (function) | Mechanics saw only assigned work, and unassigned work was invisible to all of them. This is the Roman/Ivan difference. | V1 / B1 on `main`. | Fixed |
| M2 | High (integrity) | On `main`, a mechanic's whole-shop save can rewrite a completed work order (status, jobs). | V5 on `main` ("completed refusal reported" fails). | Fixed in v24.72.0 on this branch, which is not yet merged. |
| M3 | Medium (data) | Part **buy cost** (`unitCost`) was sent to mechanics in the shop record and in the add-part response. Parts search already hid it. | V2; S2 "add part: leaked unitCost". | Fixed |
| M4 | Medium (function) | Reopening completed work went through the whole-shop save, which the completed-record lock refuses, so the reopen never saved. | V5 | Fixed (dedicated route) |
| M5 | Low (UX) | Helper picker said "Every mechanic is already assigned" because the mechanic state held only the current user. | V2 (directory) | Fixed |
| M6 | Low (UX) | Assignments stored with different letter case did not show a name on cards. | B1 (`T_ROMAN`) | Fixed (case-insensitive display) |
| M7 | Info | There is one shop per deployment (a single `app_state`), so there is no cross-shop data to separate. Multi-shop would need a shop id on records and sessions. | n/a | Documented |

Unrelated observations are not changed here:

- The work-order PDF and inspection PDF have no prices. That was checked before opening them to all mechanics.
- Account create/activate is done by the owner through `/api/admin/users` and direct DB `active` changes. There is no "deactivate" button; the only removal path is delete. Consider adding one.

## Verification

```
DATABASE_URL=postgresql://…/ci_repro ITTR_LANGUAGE_TEST_DB=1 ITTR_REQUIRE_DB_SUITES=1 ITTR_REQUIRE_BROWSER_SUITE=1 ITTR_SUITE_REPORT=… npm run check
```

**Result:** exit 0, 22/22 suites PASSED, none skipped.

**New suite: `mechanic_visibility_integration_test.mjs`.**

- V1–V8 run against the server.
- B1 runs in the browser at phone (390 px) and desktop (1280 px) widths, including switching accounts on the same device and checking for browser errors.
- On `main`, 7 of 10 scenarios fail. On the previous branch head `8055f8c`, 7 of 10 fail. Now all 10 pass.

**Updated tests (deliberate policy change):**

- `security_integration_test.mjs` S2: reads now include every work order. Office-only keys and buy costs must still never appear, and acting on another mechanic's work is still refused.
- `photo_integration_test.mjs`: another mechanic may view photos. Uploading and changing are still refused.
- `ai_permissions_integration_test.mjs`: AI lists every work order for mechanics.
- `finance_center_integration_test.mjs`: the mechanic's users payload has their own activity plus a name-only directory.

**Not tested:**

- Real devices.
- The production accounts.
- Real Railway and the network.
- Offline queues across a policy change. A queued edit to a work order the mechanic is not on is refused and reported, not lost silently.

## Deployment and rollback

**Migration:** none. v24.74.0 adds an additive column. No new settings.

**After deploy:**

1. Mechanics reload the app; the service worker version changes.
2. Ask Roman and Ivan to open **My Work Orders**. Both should see the same Ready and Upcoming lists.

**Rollback:** redeploy the previous version. Mechanics go back to assignment-only lists. Reopening by a mechanic is then refused by the v24.72.0 lock (on v24.72–v24.74) or works through the old save (on v24.71.1). No data is changed by v24.75.0 itself.
