# ITTR ShopFlow v24.76.0: fixes for the October 19, 2026 audit of v24.75.3

**Audited baseline:** `main` at `67c178d2ebc69005b0aad16ee6a727d3c5a25b38` (v24.75.3). This was confirmed to be current `main` before work started.

**How testing was done:**
- Disposable accounts and data on a local server with a throw-away PostgreSQL 16 schema.
- Real Chromium driven by Playwright.
- Production was not contacted. The live site is blocked from this environment.
- No real email, SMS, payment or AI provider was called.
- The audit-only instrumentation in draft PR #79 was **not** merged or copied.

**New suite:** `audit_v24_76_test.mjs`, 46 scenario results (A1–A21, V2–V7), now part of `npm run check`. The reproduction table below covers A1–A10; A11–A21 and V2–V7 cover the investigation items, the later improvements and the verification areas.

## Reproduction evidence

The final suite was run against the untouched baseline, and against the baseline with only fix 1 applied. Fix 1 is needed to see the others, because without it the manager cannot reach Parts or Invoices at all.

| Scenario | Baseline `67c178d` | Baseline + fix 1 only | v24.76.0 |
|---|---|---|---|
| A1 permissions (3 managers + revoke) | FAIL ×4: every permission-controlled view missing | PASS | PASS |
| A2 stock → inventory announcement; open Parts converges | FAIL: notice says only `invoices` | FAIL: Parts keeps 10 | PASS |
| A3 reconnect refreshes missed areas | FAIL | FAIL (Invoices not refetched) | PASS |
| A4 Refresh over invoice editor; draft protected | FAIL | FAIL: `page.click` timeout, intercepted by the modal | PASS |
| A5 Operations history controls | FAIL: `column "correction" does not exist` (500) | FAIL (same) | PASS |
| A6 slow page after newer navigation | FAIL | FAIL: address became `#parts` on Customers | PASS |
| A7 older search answer | FAIL: shows "Older Search Fleet" for "newer" | FAIL (same) | PASS |
| A8 offline sign-out | FAIL: `activeInvoice` kept | FAIL (same) | PASS |
| A9 New Work Order dialog | FAIL: no `role=dialog` | FAIL (same) | PASS |
| A10 portal photo viewer | FAIL: thumbnails are not buttons | FAIL (same) | PASS |

**Extra evidence for A3 (Parts specifically):** a separate probe on the baseline, signed in as the owner and as a full manager, stopped the socket and added 3 to stock. After reconnect there were 0 `/api/parts` requests and the screen still showed 9.

## Confirmed findings and fixes, in audit order

| # | Finding | Status | Fix (source) |
|---|---|---|---|
| 1 | Manager permissions lost in the browser | Fixed | `ittrSessionFromUser()` builds the page session from the server account record, permissions included. It is used by both login and the reload restore (`public/index.html`). A changed permission is picked up on a "Manager permission required" answer, on socket reconnect and when the tab becomes visible; the menu and page then follow. The server still checks every request. |
| 2 | Stock changes announced only `invoices` | Fixed | `touchDataDomain()` (`server.js`) is called by `postInvoiceLineStock`, `releaseInvoiceReservations`, `receivePartStock`, the work-order part add/remove routes, parts receiving (inventory + bills) and inventory repair. After a successful response the middleware announces every area touched. Invoice finalize, void, payments and delete also announce `customers` (balances). |
| 3 | Reconnect did not reconcile independently loaded screens | Fixed | Per-area revisions plus a boot id. The socket's `connected` message carries the revisions the account may see. The page refreshes only areas whose revision moved, once and coalesced, with the existing "don't overwrite while typing" rule. The first connect after sign-in only records them. |
| 4 | Stale-data Refresh blocked by the invoice modal; it reloaded only the list | Fixed (runtime-confirmed) | The note now sits at z-index 2500, above the workspace at 1200–1400. Refresh reloads the **open invoice**. An editor with nothing unsaved, not typed in during the last 3 s, reloads by itself when **another** device changed invoices (this account's own autosave never reloads it). An unsaved draft prompts "Keep my changes / Load the newer version" (`ittrStaleRefresh`, `ittrChoose`). "Unsaved" means the editor's own save state is dirty, saving or error, or the field values differ from the last render. |
| 5a | "Audit / Repair History Links" threw `reconcileFullbayHistory is not defined` | Fixed | The handler is now on `window`. Failures show in the status line and as a toast (`public/modules/procenter.js` + mirror). A scan of every module page found no other inline handler without a global binding. |
| 5b | `GET /api/fullbay/history/import-audit` returned 500 | Fixed | The query uses `actual_correction` / `part_amount`. Tested with empty and populated imported history. Import SQL is unchanged. |
| 6 | A slow page committed address and title after a newer navigation | Fixed | `showView()` re-checks its transition token after `afterShow()`; only the newest navigation commits history, title, scroll and cleanup. Modules that load in `mount()` (Parts, Customers, Invoices, Estimates, Operations, Truck search) set `loadsOnMount`, so the first open makes one request instead of two. |
| 7 | An older search answer overwrote a newer query | Fixed | Generations plus `AbortController` for the global search, the customer smart directory and the Parts list. Both success and error paths are guarded, and clearing the box cancels the pending request. |
| 8 | Offline sign-out kept the open invoice | Fixed | `ittrClearPrivateViews()`, called from `ittrEndSession()`, clears: the invoice and its editor; profile, directory and search caches; field values; tables drawn from the shop record; and every lazily loaded page. Account-bound unsent edits (sync queue, photo queue, drafts) are not touched. |
| 9 | Dialogs lacked semantics and focus containment | Fixed | One layer for every `.modal`: `role="dialog"`, `aria-modal` and a name from its heading; initial focus; Tab / Shift+Tab kept in the top dialog (so nesting works); Escape; "Keep editing / Discard changes" when fields changed (Escape or ×); focus returned to the opener. |
| 10 | Portal photo viewer not keyboard-usable | Fixed | Thumbnails are named buttons. They open the shop's existing viewer (`photo-viewer.js`): dialog, Close, Escape, zoom, focus trap and focus back on the thumbnail. |

## Items that needed investigation

| Item | Result |
|---|---|
| Barcode "Cannot stop, scanner is not running or paused" | **Confirmed and fixed.** `Promise.resolve(x.stop())` let a synchronous throw escape; it now uses `new Promise(r => r(x.stop()))`. Test A11. Not tested with a real camera. |
| Reports overview overflow at 390 px | **Not reproduced** with populated data (finalized invoice and payment). Page width stayed 390 (A13), and all pages for 5 accounts at 390, 820 and 1280 px fit (A15). The audit's exact data set was not available, so this stays open as "not reproduced". |
| Purchase-order rows not keyboard-accessible | **Confirmed and fixed.** The PO number is a real button (A12). |
| Click timeouts / missing-label observations | Not reproduced individually. The A15 sweep (all allowed pages, 5 accounts, 3 widths) found no page errors or overflow. No product defect is claimed. |
| Customer-link list and revoke ignored manager permissions (found by the A14 matrix) | **Confirmed and fixed.** Listing and turning off links now follow the creation rules: estimate needs Invoices; portal needs Customers and Invoices; inspection is open to any manager. Before, any manager could list every link (customer ids, signer names) and turn off portals outside their permissions. |

## UI/UX improvements made

- The manager permission editor explains what each permission opens and which actions need two permissions.
- The customer portal shows "Updated <time> · Refresh". Refresh keeps choices, name and note, and keeps the old data if the refresh fails.
- Fewer duplicate requests: one first load per page (finding 6), and one coalesced refresh per area.
- **Operations on tablets (A18):** a tool search box, a Favorites group (star any tool; remembered per account on that device), two columns at ≤ 900 px and one at ≤ 600 px. Every existing tool is still there.
- **Mechanic job details (A19):** a job that was never started shows "Not started" instead of empty start/stop rows. The add-part form folds behind "+ Add part"; it is open while that job's timer runs and stays open after adding a part.
- **Work-order Billing (A17):** "Documents for this work order" lists its estimates and invoices (number, status, total, balance), and each opens directly. Needs the Invoices permission (`GET /api/work-orders/:id/billing-links`, 403 otherwise).
- **Invoice header conflicts (A16):** see "Remaining risks" (closed).

**Not done:** timing measurements on real shop tablets (needs the devices).

## Coverage matrix (what the evidence supports)

| Area | Status | Evidence / reason |
|---|---|---|
| 1 Role & account testing | **PASS (disposable accounts)**; Roman/Ivan **BLOCKED** | See detail below. |
| 2 Cross-platform sync | **PASS (partial)** | See detail below. |
| 3 Every actionable control | **PASS (partial)** | A21 lists every visible control on every allowed page for the owner, a restricted manager and a mechanic (count logged per page) and requires each to have an accessible name. Clicking each control and checking the server result was **not** done; only the controls in the scenarios above were exercised. |
| 4 Security boundaries | **PASS (partial)** | See detail below. |
| 5 Portal isolation & approvals | **PASS (partial)** | See detail below. |
| 6 Email & integrations | **NOT TESTED here** / **BLOCKED** | Real providers were not used. Provider acceptance vs delivery and duplicate-send prevention are covered by `portal_email_integration_test.mjs` (fake providers). Bounce visibility, deliverability, SMS, payments and AI need authorized test modes. |
| 7 Financial & inventory integrity | **PASS (partial)** | See detail below. |
| 8 Mechanic workflows on real devices | **BLOCKED** | Needs physical tablets and phones, cameras, gloves and cellular networks. Emulated widths only (A15). |
| 9 Accessibility & consistency | **PASS (partial)** | See detail below. |
| 10 Deployment & recovery | **BLOCKED** / **NOT TESTED** | See detail below. |

**Area 1 detail.**
- A1: full, restricted and mixed managers through login, reload, account switch and revocation.
- A14: API matrix of 13 endpoints across owner, three managers and a mechanic. A mechanic sees another mechanic's work order but cannot start its timer.
- A15: 5 accounts × 3 widths.
- Roman's and Ivan's live configuration was not inspected.

**Area 2 detail.**
- Covered by A2, A3, A4, V2 (payment → balance → portal) and the existing suites: sync queue, conflicts, offline, account switching.
- Not covered end to end:
  - the work order → board → invoice chain in two browsers
  - findings approval → billing in two browsers
  - browser sleep/wake

**Area 4 detail.**
- PASS:
  - A14 permission matrix
  - customer-link scoping (fixed)
  - V4: CSP, nosniff and framing headers; identical answers for an unknown user and a wrong password; repeated wrong passwords are throttled or locked; no keys in browser files
  - existing security suites (S1–S5, XSS, sessions, sockets)
  - `npm audit --omit=dev`: 0 vulnerabilities
- NOT TESTED: a full per-endpoint review of every route, CSRF (the API uses bearer tokens, not cookies), upload fuzzing, production headers and HSTS.

**Area 5 detail.**
- V5: another customer's invoice PDF returns 404; a revoked portal and an unknown token are refused.
- Existing portal suite: partial approvals, expiry, child links.
- Forwarded-link behaviour is by design (bearer link) and was not changed.

**Area 7 detail.**
- V7: three simultaneous finalizes take stock once.
- V2: rounding with 50.005, partial payment; an overpayment is refused or never makes a negative balance.
- Existing inventory and finance suites.
- Observed policy: two invoices finalized together for the last unit both succeed and stock goes to −2. Negative stock is allowed with a warning by design; flagged for the owner to decide.
- Not verified: a full ledger reconciliation against reports, or rollback on mid-operation failure beyond existing tests.

**Area 9 detail.**
- PASS: A9 dialogs, A10 portal viewer, A12 PO rows, A15 widths, A20 200% zoom (640×450 CSS px) and phone landscape (844×390) for owner and mechanic with no sideways scrolling, A21 accessible names, existing UX suite.
- NOT TESTED: screen readers, contrast measurement, real browser zoom on devices.

**Area 10 detail.**
- The deployed build, schema, backups, monitoring and service-worker update on real devices cannot be reached from here.
- Migration: none. Revisions are in memory only, so a restart changes the boot id and each page refreshes its current area once.

## Production-only checks for the owner

1. After deploy, `/api/health` reports v24.76.0. Each device picks up the new service worker (cache `ittr-shopflow-v24.76.0`).
2. Sign in as each real manager and confirm their menu matches their permissions.
3. Run the read-only Roman/Ivan account queries from `docs/MECHANIC-VISIBILITY-v24.75.0.md`.
4. With Parts open on a second device, finalize a one-part invoice; the quantity should update without a reload.
5. Real-device checks: barcode camera start/stop, photo upload over cellular, dialogs with a keyboard on a tablet.
6. Backup restore rehearsal in a non-production environment.

## Remaining risks

- **Single instance assumed.** Revisions and change announcements live in one server process; several instances would each have their own (same assumption as the live socket today).
- **Closed: clean invoice editor refresh.** It now reloads by itself (A4).
- **Closed: header autosave race.** The invoice carries a header fingerprint. The autosave sends the one it started from; if another device changed the header, the server answers 409 `INVOICE_HEADER_CHANGED` and the person chooses "Keep my changes (save over theirs)" or "Load the newer version". Only one question is shown at a time (A16 found and fixed a double prompt). Line edits do not change the fingerprint. Older clients that send no fingerprint behave as before.
- **Not a full security review.** This is not a complete security review or penetration test, and does not show the platform is fully secure.
