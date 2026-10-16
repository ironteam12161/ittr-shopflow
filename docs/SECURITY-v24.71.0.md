# ITTR ShopFlow v24.71.0 — security fixes for the October 16, 2026 audit

Baseline: v24.70.0, commit `6539a7bd477fde66691817b7ab2364c768644901` (the audited commit; `main` had not moved).
Each finding was re-checked against that code before changing it. Tests were run only against throw-away local
databases. Production was not contacted, changed or deployed to.

This release closes the specific paths listed below. It does **not** make the application "unhackable". The
remaining risks and the deployment checks that need owner access are listed at the end.

## Findings

| ID | Severity | Re-check on baseline | Status | Proof |
|---|---|---|---|---|
| S1 stored JS injection (unit/customer names in inline handlers) | High | Confirmed: unit text in `onclick="…('${encodeURIComponent(x)}')"` breaks out on `'`. Also found `h()`-escaped text inside a quoted handler argument in `inspection-workflow.js` (`&#39;` decodes back to `'` before the handler runs). | Fixed | `inline_handler_guard.mjs` (static, runs in `npm run check`), `security_browser_test.mjs` S1 |
| S2 mechanic responses show other mechanics' work | High | Confirmed: add/remove helper, add/remove part, task action, self-start and mechanic activity returned the whole shop record. Also found: `/api/mechanic/focus-inspection` and time-clock punch (clock-out) returned it. `GET /api/state` already filtered work orders but still passed through other top-level keys. | Fixed | `security_integration_test.mjs` S2 (fails on baseline, passes now) |
| S3 search routes skip granular permissions | High | Confirmed: `/api/smart-search` returned customer contact and invoice balances to any manager; `/api/customer-units/suggest` returned customer phone/email (and Samsara GPS/driver columns via `u.*`) to mechanics. Also found: the self-start lookup sent customer phone/email/address to mechanics; `/api/service-orders/:id/to-invoice` created invoices without the Invoices permission. | Fixed | `security_integration_test.mjs` S3 matrix |
| S4 live sockets outlive sessions; unscoped broadcasts | Medium | Confirmed | Fixed | `security_integration_test.mjs` S4 (separate socket stays open) |
| S5 logout leaves shop data on the device | Medium | Confirmed | Fixed (with account-bound recovery of unsent work) | `security_browser_test.mjs` S5 |
| E1 health check passes with the database down | Medium | Confirmed. Also found: no `pool.on("error")`, so a dropped database connection could crash the app. | Fixed | `security_integration_test.mjs` E1 (real TCP outage) |
| Dashboard does not show a mechanic's inspection (owner report) | Bug | Several real causes found (see below); the exact production trigger could not be reproduced without production data. | Fixed causes found | `security_browser_test.mjs` #96 |

## What changed

### S1 — injection (`public/index.html`, `public/inspection-workflow.js`, `public/modules/procenter.js`, `server.js`)
- Handlers that carried text (search results, vehicle-profile history, customer history, part labels and barcodes,
  core attachments, task parts, time adjustments, invoice customer/fee/delete, Fullbay paging) now use
  `data-act` + `data-args` (JSON, HTML-escaped) and one delegated click listener that only calls names in an allowlist
  (`ITTR_ACTIONS`). No text is ever parsed as JavaScript.
- Remaining inline handlers pass values through `jsArg` (ids: digits or a plain token), `jsStr`/`ja`
  (`JSON.stringify` + HTML escape) or `Number`. The static guard fails the build if a new handler interpolates anything
  else.
- Labels were already escaped with `esc()`/`h()`; the frontend was swept for raw `${…}` of user fields (toasts use
  `textContent`, the SMS screens and report cards escape).
- Names with apostrophes keep working (`O'Brien`), and are shown literally.
- CSP: `connect-src` narrowed from `'self' https: wss:` to `'self'` plus this host's `wss:`/`ws:` (the app makes no
  cross-origin requests), so injected code could not send data to another site with `fetch`/`WebSocket`.
  `script-src 'unsafe-inline'` and `script-src-attr 'unsafe-inline'` stay for now: about 1,000 inline handlers remain
  and removing them in one release would break the app. `img-src https:` stays because photo links are signed R2 URLs
  whose host could not be confirmed from here.

### S2 — one serializer for the shop record (`server.js`)
- `shopflowForUser(user, sf)` is the single place that decides what an account receives. A mechanic gets only work
  orders they are primary or helper on, those work orders' findings, and `lastWorkOrderId`; any other top-level key stays
  on the server (a mechanic's save already keeps server keys — see the PUT merge).
- Used by `GET /api/state`, the history-version endpoint (baseline-preserving offline replay), every mechanic mutation
  (helpers, parts, task start/pause/resume/finish, self-start, activity, focus-inspection, add inspection repair) and
  the time clock (punch responses no longer carry the shop record at all).
- The phone already worked from the scoped copy (`GET /api/state`), so adopting scoped mutation responses does not
  erase other state on the phone.

### S3 — per-category permissions (`server.js`)
- `/api/smart-search`: customers and Fullbay service history need **Customers**; invoices and Fullbay invoice numbers
  need **Invoices**; unit notes need **Customers**. Work orders, inspections, units and parts stay for every manager
  (shop-floor data). Forbidden categories are not queried at all.
- `/api/customer-units/suggest`: explicit columns (no Samsara GPS/driver); customer phone/email only for the owner and
  managers with Customers or Invoices (estimates pre-fill the email). Mechanics still find units.
- Self-start lookup: mechanics no longer receive the stored customer's phone, email or address. Public FMCSA carrier
  details are still returned (a new customer is created from them). USDOT/VIN self-start is unchanged.
- `/api/service-orders/:id/to-invoice` now needs Invoices, like `POST /api/invoices`.

### S4 — live socket (`server.js`)
- Each socket stores the session id. Sessions are re-checked every 15 s and immediately after any successful
  sign-out, "sign out other devices", password change/reset, 2-step change, account create/delete/permission change.
  A socket whose session is gone, expired, or whose account is inactive is closed (code 4001). A timer also closes it
  at the session's expiry time. Role and permissions are refreshed on each check.
- Messages are filtered: mechanics get only `{type, at}` refresh signals for shop changes and never customer-decision
  or text-message events; customers get nothing.
- `maxPayload` 4 KB, at most 12 sockets per account, 600 total, 200 waiting for sign-in (env-adjustable).
- The `?token=` URL form is refused unless `ITTR_LEGACY_WS_TOKEN=1` (current apps send the token in the first message
  since v24.58.1; older copies still get updates through the 4-second poll).

### S5 — shared device (`public/index.html`, `public/sync-queue.js`)
- When a session ends (sign-out, expiry/revocation, another account signing in) the device's read copies are removed:
  `ittr_shopflow_v2`, `ittr_users_v1`, `ittr_pro_v20`, the AI translation caches and the old (never restored) vendor
  receiving draft; the in-memory copies are emptied. A sign-out while online reloads the page so nothing stays in
  memory or on screen.
- Unsent work is **kept and bound to its account**: queued edits (`ittr_sync_queue_v3:<user>`), queued photos (IndexedDB,
  per account) and the mechanic's self-start draft. Before signing out the app tries to send the queue (up to 4 s);
  if something is left it tells the person it is kept on this device and will be sent when they sign in here again.
  Another account signing in on the same device neither sees nor sends it.

### E1 — readiness (`server.js`)
- `/api/health/live`: always 200 while the process answers.
- `/api/health` (= `/api/health/ready`, Railway's deploy check): 503 unless the database answers within 5 s and the
  core tables exist. AI, photo storage and parts-index state are reported but never fail it.
- `pool.on("error")` added, so a database blip is logged and the app recovers instead of crashing.
- Startup is unchanged: the server only listens after all migrations; a migration or connection failure exits with an
  error, so Railway never routes traffic to it. `railway.json` needs no change (`healthcheckPath: /api/health`).
  Railway runs this check at deploy time; a later database outage does not restart the app.

### Owner dashboard not showing a mechanic's inspection
Causes found in the code (any of them can hide a mechanic's live inspection):
1. Several responses moved the page's server version forward without taking the data (delete work order, add inspection
   repair, inspection saves, parts/fees). If another device saved in between, the next refresh thought it was current
   and skipped that device's change. Now the version only moves forward by exactly one (our own change); otherwise the
   page refreshes.
2. A live "something changed" signal that arrived while a refresh was running was dropped. Now one more refresh runs.
3. While the owner had any unsent change waiting (offline, server busy, a retrying save), every newer server copy was
   skipped, so the dashboard froze. Now the newer copy is taken and the waiting change is put back on top
   (`ittrSync.rebase`).
4. Job timer start/pause/finish, helper and part changes did not send a live signal at all (only the 4-second poll
   of a visible tab saw them). They do now.
5. After the live connection reconnected the page did not refresh. It does now.
6. A mechanic reading or measuring for more than 30 minutes without answering an item dropped off "Inspecting". While
   the inspection is open on screen the phone now reports it every 4 minutes.

## Tests

- `inline_handler_guard.mjs` — static, fails on raw interpolation into inline handlers (part of `npm run check`).
- `security_integration_test.mjs` — mechanic A vs B on every mechanic route (including error responses), role ×
  permission matrix with negative field assertions, lingering-socket revocation (logout, revoke others, password reset,
  account delete, expiry), socket filtering, legacy token, oversized frame, readiness with missing schema, a real
  database outage through a TCP relay, and startup with no database.
- `security_browser_test.mjs` — Chromium: hostile names in search/profile/history/truck search/invoice lookup never run
  and display literally; logout and expiry clear caches; unsent mechanic edit survives an account switch and is saved
  for the same mechanic; owner dashboard shows the inspection while the owner has a change waiting.
- On the unfixed baseline the integration suite fails 10 of 11 scenarios (the one passing is "touching B's work order is
  refused", which was already correct).

## Migration and rollback
- No database migration. No new dependencies. New optional environment variables: `ITTR_LEGACY_WS_TOKEN`,
  `ITTR_LIVE_MAX_PER_USER`, `ITTR_LIVE_MAX_TOTAL`, `ITTR_LIVE_MAX_PENDING`, `ITTR_LIVE_RECHECK_MS`, `ITTR_DB_SSL_VERIFY`,
  `PGSSLROOTCERT`.
- Rollback: redeploy v24.70.0. Nothing stored changes shape. Devices keep their queued edits across the rollback
  (same queue format). The service worker cache name changes, so phones pick up the new or old version on next load.

## Remaining risks and actions that need owner access (not verified here)
- **Database TLS**: external connections default to encrypted-but-unverified (`rejectUnauthorized:false`). If the
  production database is not on Railway's private network, set `ITTR_DB_SSL_VERIFY=1` (and `PGSSLROOTCERT` if the CA is
  not public). The production connection string was not inspected.
- **Legacy customer ownership**: the customer portal still matches invoices/estimates with no customer id by name. Two
  customers with the same name could see each other's old unlinked records. Needs a reviewed data migration that links
  those records to ids; production data was not inspected.
- **Upload and load limits**: CSV uploads allow 80 MB in memory, manuals 250 MB on disk, JSON 3–10 MB. Per-user upload
  concurrency is not limited. Check Railway/proxy limits and memory under a controlled load test.
- **MFA**: 2-step login is recommended for owner/managers but not enforced. Decide whether to require it; check the
  owner's and managers' enrollment and the trusted-device lifetime.
- **Photo storage**: signed links last 10 minutes. R2 bucket ACLs, key scope and lifecycle were not inspected.
- **Backups**: owner-only backup export exists; encryption, retention and restore drills of the Railway database were
  not inspected.
- **AI providers**: work-order text, notes, manuals and photos may be sent to OpenAI/OpenRouter. Provider retention
  and contract settings were not inspected.
- **GitHub**: branch rules and required checks were not inspected in this change (no repository settings were changed).
- **Still allowed for every manager by design**: customer texting threads, customer links, fleet maintenance reminders,
  service-order review. Consider gating them under Customers if some managers should not see customer contacts.
- **CSP**: `'unsafe-inline'` remains for scripts until the remaining inline handlers are moved to listeners; the
  static guard keeps new ones safe meanwhile.
