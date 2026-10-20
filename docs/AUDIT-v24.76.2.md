# ITTR ShopFlow v24.76.2: fixes for the October 20 audits

**Baseline:** `main` at `7b717d6` (v24.76.1, PRs #80–#84 merged). That is the code the October 20 audits ("ITTR ShopFlow: current-main audit" and "Expanded audit") examined.

**How it was tested:**
- Disposable accounts and data on a local server, with a throw-away PostgreSQL 16 schema.
- Real Chromium driven by Playwright, using real pointer clicks and keyboard input.
- Twilio webhooks were signed with a test secret. Outgoing email and SMS went to a local stand-in.
- Production was not contacted. No real email, SMS, payment or AI provider was called. No customer message was sent.

**Evidence rule:** every fix has a scenario in `audit_v24_76_test.mjs` that **fails on the previous code** (shown in each table) and passes now.

## Audit findings F1–F7

| # | Finding | Status | Fix | Test (failure on previous code) |
|---|---|---|---|---|
| F1 | Invoice autosave said "All changes saved" while the newest edit had not been sent | **Fixed** | An edit made while a save is on its way queues one more save. The label says "Saving latest changes…" until then. "All changes saved" shows only when what the server confirmed equals what is on screen. | A41: the newer note never reached the server. |
| F2 | A slow load of an older invoice replaced the invoice opened after it | **Fixed** | Each open is numbered. An answer for an older open, or for an editor that was closed meanwhile, is ignored. | A41 |
| F3 | Estimates: a save redrew the editor and took the cursor out of the field being typed in | **Fixed** | After a save, the editor puts back what is being typed in other fields, the focused field and the cursor position. An older answer, or one for a closed estimate, is ignored. | A42: focus ended on `BODY`. |
| F4 | The invoice summary covered Mileage and PO # at 1280 and 1440 px | **Fixed** | The billing fields' columns follow the width of their own card (CSS container queries), instead of fixed minimum widths that ran under the summary. | A43: Mileage, PO #, Shop supplies and the environmental fee were covered at 1440 px. |
| F5 | A restricted manager could email a known customer link | **Fixed** | Emailing a link uses the same permission check as creating it: estimate links need Invoices; portal links need Customers and Invoices. | A39: 5 of 18 role/link combinations were allowed. |
| F6 | A repeated (replayed) START text could undo a later STOP | **Fixed** | Each incoming text is recorded once by its Twilio id inside a transaction. STOP/START take effect only the first time. | A39: the opt-out was removed. |
| F7 | A new incoming text cleared the reply being typed | **Fixed** | A new text adds to the message list only. The reply box keeps its text, focus and cursor. Sending clears the box only if it still holds what was sent. | A40: the draft was emptied. |

## Risks from the audits

| Risk | What changed | Test |
|---|---|---|
| The button sweep was not a release gate and used DOM `.click()` | The sweep now clicks with a real pointer, so a control covered by another element is reported as a problem. It is now part of `npm run check`. The A-scenarios added here also use real clicks and typing and check what was saved on the server. | `control_sweep_test.mjs`; A41–A43 |
| Backup held each whole table in memory, ignored a slow download, and a failure part-way left a cut-off file | Rows are read through a database cursor in batches of 500. They are written only as fast as the download takes them. A closed download stops the export. The file ends with `"complete": true`. A failure after the download started breaks the connection, and the Download backup button checks the ending, so a cut-off file is never saved as a finished backup. | A44: the previous code had no completion marker, and its download ended normally after a failure. |

## Found by the real-pointer sweep

Once the sweep clicked with a real pointer, it found these. Each is fixed and covered by A45, which fails on the previous code.

| # | Finding | Fix |
|---|---|---|
| S1 | Escape did nothing in the Fluids in gallons, parts vendor bill and Fullbay price check dialogs. The dialog stayed over the page. | Escape closes them. |
| S2 | Escape did nothing in the estimate's "Create work order" box, or in any other self-drawn dialog without its own Escape. | The dialog layer now lets a dialog's own Escape handling run first. If the dialog is still open, Escape does what its Close/Cancel button does, asking first when something was typed. |
| S3 | On a phone, a control scrolled into view (keyboard Tab, a tap target near the end of a page) could sit under the fixed bottom menu. Seen on "How My Work Orders works". | Scrolling keeps controls above the bottom menu (`scroll-padding-bottom`). |
| S4 | The Tire fees dialog did not keep Tab inside it and had no dialog name for screen readers. | It joins the shared dialog layer. |

**Sweep result:** 882 controls clicked with a real pointer on 56 role/page combinations; 137 skipped as destructive or outbound. None was covered, and there were no page errors, server 5xx answers, failed requests or sideways scrolling. Browser questions are dismissed, so nothing guarded runs. The one exception is "close without saving", which is accepted: it only throws away what the sweep typed.

## Coverage (what the evidence supports)

- **New scenarios:** A39–A45 in `audit_v24_76_test.mjs`.
- **Full check:** `npm run check` with PostgreSQL 16 and Chromium, `ITTR_REQUIRE_DB_SUITES=1 ITTR_REQUIRE_BROWSER_SUITE=1`. The result is in the pull request.
- **Not tested:**
  - production
  - Roman's and Ivan's live accounts
  - real devices, cameras and cellular networks
  - real email, SMS, Stripe and AI providers
  - screen readers and contrast measurement
  - multiple server instances
  - a real backup restore drill
- **The sweep checks that each control can be reached and works without errors.** It does not check every control's business result on the server; the A- and V-scenarios do that for the flows they name.
- **This is not a full security review or penetration test**, and it does not show the platform is fully secure.

## Remaining risks

- **Single server instance assumed.** Live announcements and revisions are kept in one process. Confirm the Railway replica count before adding replicas.
- **CSP still permits inline scripts.** Defence in depth only; no injection was found.
- **Recovery is still unproven.** The backup file is now complete or visibly failed, but a restore rehearsal on a safe environment has not been done. Photos in object storage and separately kept settings (keys, provider accounts) are not in the database backup.
- **Provider delivery** (email, SMS, card payments) is not proven by stand-in tests.

## Deployment and rollback

- No migration and no new settings. `ITTR_BACKUP_BATCH` is optional (rows per batch, default 500).
- After deploy, `/api/health` and `/api/build` report 24.76.2, and devices pick up service-worker cache `ittr-shopflow-v24.76.2`.
- Managers with Invoices but not Customers can no longer email portal links. That matches what they could already create.
- **Rollback:** redeploy v24.76.1. No data is changed by this release.
