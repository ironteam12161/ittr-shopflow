# ITTR ShopFlow v24.76.1: fixes for the October 19 current-main audit, plus an engineering review

**Baseline:** `main` at `023acc964aefc16d47681d4dcf5263b6ed01b841` (v24.76.0, PRs #80–#82 merged). This is the snapshot the external audit "ITTR ShopFlow: current-main engineering, security and UI audit" examined.

**How it was tested:**
- Disposable accounts and data on a local server, with a throw-away PostgreSQL 16 schema.
- Real Chromium driven by Playwright.
- The Stripe webhook was exercised with a test signing secret.
- Production was not contacted. No real email, SMS, payment or AI provider was called. No customer message was sent.

**Evidence rule:** every fix has a scenario in `audit_v24_76_test.mjs` that **fails on the previous code** (shown in each table) and passes now.

## External audit findings R1–R9

| # | Finding | Status | Fix | Test (failure on previous code) |
|---|---|---|---|---|
| R1 | Restricted managers could call Compliance APIs directly | **Fixed** | Compliance routes now require the **Customers** permission, as the menu does. This covers units, inspection documents (read, create, delete, PDF), fleet maintenance and reminders. The nav badge no longer calls the API without Customers. | A24. A manager with Invoices + Inventory but no Customers got 200 on 8 calls. One of them deleted an inspection document, so the next read returned 404. |
| R2 | Stale invoice saves silently overwrote newer lines | **Fixed** | See "R2 and R7 in detail" below. | A25. Saving only the header wrote "ORIGINAL LABOR" back over the other device's "REMOTE CORRECTED LABOR". |
| R3 | A four-second guess hid same-account changes | **Fixed** | Each tab sends a random per-tab id (`X-ITTR-Client`; not a secret, not a token). Change announcements list the tabs that made them, and "my own change" now means this tab only. Changes with no tab (webhooks, background jobs) count as someone else's. | A27. The phone's change right after this tab saved something was never shown. |
| R4 | Customer estimate decisions did not refresh Estimates | **Fixed** | After the decision commits, the public decision route announces the invoices/estimates area. The Estimates page reloads the list, and the open estimate unless a field in it is being edited. Pages that were offline catch up on reconnect. | A28. The list kept SENT. |
| R5 | Stripe payments bypassed live updates | **Fixed** | A successful new payment announces invoices and customers. A replayed event announces nothing and records nothing. | A29. The open invoice never showed the payment. |
| R6 | Estimates and Purchase Orders bypassed dialog safeguards | **Fixed** | See "R6 in detail" below. | A31. The estimate number button did not exist. |
| R7 | A saved header still left the invoice internally dirty | **Fixed** | Covered by the R2 snapshot change below. | A26. The editor counted as unsaved after the autosave. |
| R8 | Estimate rows could not be opened from the keyboard | **Fixed** | The estimate number is a real, named button. The row stays clickable. | A31 |
| R9 | The login password label was not tied to its field | **Fixed** | Username and Password labels now use `for`. The 2-step code field already had one. Clicking a label focuses its field, and the name stays when the password is shown. | A30. `loginUser`, `loginPass` had no label at 390 px. |

### R2 and R7 in detail

**Line fingerprints.**
- Every invoice line now carries a fingerprint. It covers the line's type, text, part, quantities, prices, discount, job and links; stock bookkeeping columns and timestamps are left out.
- A line save sends the fingerprint it loaded. If the line has changed since, the server answers 409 `INVOICE_LINE_CHANGED`.
- The person chooses "Keep my changes" (saved on purpose) or "Load the newer version".

**What gets saved, and in what order.**
- Only lines the person actually changed are saved; untouched lines are never written back.
- The header is saved first, with its own conflict check. If that check stops the save, no line has been written yet.

**Last-saved snapshots (also fixes R7).**
- The editor keeps separate snapshots for the header, each line and its other fields.
- A successful save moves forward only the snapshot for what it saved.

### R6 in detail

**Estimates editor and purchase-order forms.**
- They register with the shared dialog layer: `ittrOverlayOpened(box, {close})` and `ittrOverlayClosed(box)`.
- They now have a dialog name, keep Tab and Shift+Tab inside, and return focus to the opener.
- Escape, and the Close/Cancel buttons, ask "Keep editing / Discard changes" when something was typed.
- Re-rendering after a field saves takes a new baseline.

**Other self-drawn dialogs.**
- Payment, confirm, Bills, Reports, Compliance, and the estimate email and work-order boxes are picked up automatically when they appear. They get the dialog name, focus trap and focus return, and keep their own Escape behaviour.

## Findings from my own review

| # | Finding | Severity | Status | Test |
|---|---|---|---|---|
| E1 | Customer texting needed only "any manager". A manager without Customers could read every text thread and customer phone number, and send texts. Live `sms_received` messages (phone and preview) reached every manager. | P1 (permission boundary) | **Fixed**: texting requires Customers, and the live text and estimate-decision messages go only to managers with Customers or Invoices respectively. | A24 (`/api/sms/threads` and `/api/sms/config` gave 200 for a manager without Customers) |
| E2 | The mechanic productivity report (employee hours) and service orders (invoice drafts) needed only "any manager". | P2 | **Fixed**: they now require Reports and Invoices respectively. The service-order convert step already required Invoices. | A24 |
| E3 | The global error handler answered **500 "An unexpected server error occurred."** for every error passed to it in production. That included deliberate 4xx refusals and malformed or oversized requests, and it raised server-error alerts for them. | P2 (wrong answers, alert noise) | **Fixed**: 4xx keeps its status and message. Malformed JSON answers "The request was not valid JSON." | A32 (malformed JSON returned 500) |
| E4 | The owner backup read each table in a separate query, so a backup taken during work was not one moment in time. | P2 (recovery integrity) | **Fixed**: one read-only `REPEATABLE READ` transaction; the file says `"consistentSnapshot": true`. | A32 |
| E5 | Production exposes only a version label, which several fixes share. | P3 (deployment verification) | **Fixed**: `/api/build` also reports `commit` from `RAILWAY_GIT_COMMIT_SHA` when the host sets it, otherwise `null`. | A32 |
| E7 | All `/api/auth` calls from one IP shared 100 per 15 minutes. That includes managers' pages checking their permissions (`/api/auth/me`, added in v24.76.0) and everyone's sign-ins. On shared shop Wi-Fi, managers switching tabs could use up the allowance and block a mechanic's sign-in for up to 15 minutes. | P2 (availability) | **Fixed**: signed-in and signed-out calls are counted in separate buckets per IP (600 and 100). Failed sign-ins are still limited separately, and the login-throttling check V4 still passes. | A33 (14 of 110 signed-in checks were refused) |
| E6 | In a payment dialog over an open invoice, Tab moved into the invoice behind it, and Escape acted on the invoice instead of the payment dialog. | P2 (keyboard, risk of closing the wrong record) | **Fixed** by the dialog-layer change above, plus "an Escape already used by a dialog does not also close the one behind it". | A31 |

| E8 | The FMCSA carrier lookup made one 10-second attempt with no retry. FMCSA's QCMobile service is often slow, so the customer form showed "FMCSA lookup timed out" (reported from production for USDOT 3729465). | P2 (daily use) | **Fixed**: each attempt waits up to 15 s, and a timed-out, failed or 5xx attempt is retried once. If FMCSA still does not answer, the last result for that USDOT from the past 24 hours is shown with a note; otherwise the message says FMCSA is slow and suggests typing the details in. The name search uses the same rules. | A38 (stand-in FMCSA: slow first answer → retried and found; never answers → two tries, then the clear message) |

**Checked and found sound (no change needed):**
- **Interpolated SQL fragments:** all are fixed column or table names. Request values always go through parameters.
- **Routes with sign-in but no role middleware:** each checks the role inside (for example inventory reset is owner-only), or is meant for every role.
- **Public customer links:** 256-bit random tokens, stored only as SHA-256 hashes, with expiry, revocation and a rate limit.
- **Twilio webhooks:** they verify `X-Twilio-Signature`.
- **Invoice payments:** amount must be above zero, no payments on paid or void invoices, no more than the balance due, and duplicate references are caught.
- **Invoice delete:** owner-only, requires typing the invoice number, and keeps a snapshot first.

## Coverage (what the evidence supports)

**Control sweep (`npm run sweep`, `control_sweep_test.mjs`).**
- **What it does:** signs in as the owner, a full manager, a Customers-only manager and a mechanic (phone width). On every page each account may use, it clicks every visible safe control. When a click opens a dialog, it also clicks the safe controls inside it. It also opens the draft and sent invoice editors, the estimate editor and the mechanic's work-order detail, and sweeps inside them.
- **Result:** **893 controls clicked on 56 role/page combinations**, with no page errors, server 5xx answers, failed requests, sign-outs or sideways scrolling.
- **Skipped:** 151 controls, on purpose. These are actions that delete, void, finalize, send email/SMS/links, pay, reset, sign out, connect outside services, import, print or download. Browser confirm questions were dismissed, never accepted.
- **Limits:** the sweep checks that each control works without errors. It does not check every control's business result on the server; the A- and V-scenarios do that for the flows they name.

**Two-device and device scenarios added:**
- **A34:** the mechanic starts and completes a job on the phone, and the office sees it live. The work order is completed and invoiced, and the Billing tab links to the invoice.
- **A35:** a finding reported on the phone is approved in the office and appears on the phone as a job, which the mechanic starts.
- **A36:** a device that loses the network catches up when it comes back.
- **A37:** on a touch phone (mobile viewport, `isMobile`, `hasTouch`), the mechanic taps Start and Complete.

- **Full check:** `npm run check` with PostgreSQL 16 and Chromium, `ITTR_REQUIRE_DB_SUITES=1 ITTR_REQUIRE_BROWSER_SUITE=1`. The result is in the pull request.
- **New scenarios:** A22–A38 in `audit_v24_76_test.mjs`.
- **Not tested:**
  - production
  - Roman's and Ivan's live accounts
  - real devices, cameras and cellular networks
  - real email, SMS, Stripe and AI providers
  - screen readers and contrast measurement
  - multiple server instances
  - a real backup restore drill
  - checking every control's server result (the control sweep checks that each one works without errors)
- **This is not a full security review or penetration test**, and it does not show the platform is fully secure.

## Remaining risks

- **Single server instance assumed.** Live announcements, revisions and per-tab ids are kept in one process. Several Railway replicas would each have their own. Confirm the replica count.
- **Coalesced announcements.** Within one 300 ms announcement window, a change by this tab and another device's change to the same area are reported together. Because a foreign tab id is present, the tab treats it as someone else's change and refreshes, which is the safe direction.
- **CSP still permits inline scripts.** Defence in depth only; no injection was found here. Plan the move to nonces or hashes.
- **Backups are built in memory one table at a time.** Very large tables would need streaming. Recovery also still needs an actual restore rehearsal on a safe environment.
- **Policy question for the owner.** Negative stock is allowed with a warning, by design.

## Deployment and rollback

- No migration and no new settings. To see the deployed commit, set nothing: Railway provides `RAILWAY_GIT_COMMIT_SHA` automatically.
- After deploy, `/api/health` and `/api/build` report 24.76.1, and devices pick up service-worker cache `ittr-shopflow-v24.76.1`.
- Manager accounts without Customers lose direct API access to Compliance and texting. Their menu never showed these areas. Check that each real manager's ticks match what they need.
- **Rollback:** redeploy v24.76.0. No data is changed by this release.
