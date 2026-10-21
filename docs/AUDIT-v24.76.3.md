# ITTR ShopFlow v24.76.3: launch audit

**Question:** can the shop start using the site? This audit covers everything between "the code is merged" and "the shop works on it".

**Baseline:** `main` at `62b185e` (v24.76.2, PR #85 merged).

**How it was tested:**
- **Production mode:** the app was started exactly as Railway starts it (`NODE_ENV=production npm start`) on a brand-new, empty PostgreSQL 16 database. It was then used in a real Chromium browser:
  - an office computer for the owner and an office manager
  - a touch phone (iPhone 13 profile) for the mechanic
  - a phone for the customer pages
- **Test suites:** the full test suite was run as usual. The control sweep and the audit scenarios were also run against a **production-mode** server.
- **Not contacted:** production. No real email, SMS, payment or AI provider was called.

## Findings and fixes

| # | Finding | Severity | Fix | Test (failure on previous code) |
|---|---|---|---|---|
| L1 | **A mechanic's "✓ Truck Is Here" did nothing.** The server protected `truckHere` from mechanic saves, so the tap was silently undone. A truck the office scheduled stayed under "On the Way" and never reached "Ready to Work". The phone showed no message. This had been the case since 28 September. | P1 (blocks the mechanic's daily flow) | The assigned mechanic may mark a customer truck as arrived. They cannot set it back to "not here", and they cannot change trucks assigned to someone else. All other office-only fields stay protected. | A46: the server kept "not here". |
| L2 | **Every owner signing in to an empty database was asked** "The online database is empty, but this browser has existing ITTR data. Upload…?", even in a brand-new browser. The check counted the app's built-in empty lists as data. | P2 (confusing on day one; pressing OK overwrote the server copy with empty lists) | Only real content counts: users, work orders, or non-empty lists. | A47, and the walkthrough |
| L3 | **A malformed id gave a server error.** For example `/api/invoices/null` answered 500 "An unexpected server error occurred." and raised a server-error alert. | P3 | PostgreSQL "invalid input" errors (22P02, 22003, 22007, 22008) answer **400** with a clear message, and raise no alert. | A47: 500 |
| L4 | **New work orders made the office type a time.** The date filled in with today, but the required "Scheduled time" stayed empty. | P3 (friction on every walk-in) | An empty time fills in with the current time, like the date. | A47 |
| L5 | **Invoice line fields had no names** for screen readers: hours, rate, rate preset, discount type and amount, markup. The existing name check (A21) covers pages, not the open invoice editor. | P3 (accessibility) | Each field has a name. | A47 |
| L6 | **`.env.example` was missing settings:** Stripe payments, Twilio texting, Samsara, the shop time zone, error alerts and the 2-step-login reset. The README still described v24.28 and a start-up step that no longer exists. There was no launch checklist. | P2 (setup) | `.env.example` lists every setting the server reads, marked required or optional. The README is corrected. `docs/GO-LIVE.md` is the step-by-step launch checklist. | — |

Small cleanups:
- `/api/build` now reports `ITTR-24.76.3`. The stale `-INSPSAVE-20261013` suffix is gone.
- The test harness can run any suite against a production-mode server: `ITTR_TEST_NODE_ENV=production`.

## What was checked and found sound

- **Start-up on an empty database (production mode):** ready in about 10 s. Every table is created. The owner account comes from `BOOTSTRAP_ADMIN_*`, and parts-search indexes are built. Start-up log: no errors.
  - Health: `/api/health` reports `ready`, `db` and `schema`.
  - Background jobs: the time-clock and fleet schedulers, which run only in production, started without errors.
- **Empty shop:** all 17 owner pages open with no console errors, blocked resources, failed requests or 4xx/5xx responses. The offline service worker registers.
- **The first day, through the screens** (zero console errors, failed requests or 4xx/5xx):

  | Who | What they did |
  |---|---|
  | Owner | Added a mechanic, an office manager (Invoices + Customers + Parts) and a customer. Opened a work order assigning the mechanic. |
  | Mechanic (touch phone) | Clocked in, tapped Truck Is Here, Open Job, Start Task and Complete Task, then Complete Work Order with a note. |
  | Office | Saw it completed without a reload. |
  | Office manager | Made the invoice from the work order and entered 1.5 h at $145, for **$217.50**. The app correctly refused to finalize it while it was $0. Then finalized it, recorded the full payment (paid, balance $0) and downloaded the PDF (149 KB). |
  | Owner | Saw the $217.50 sale in Reports. |

- **Customer pages on a phone (production mode):** the estimate approval link and the fleet portal open with no errors. The portal shows the paid invoice and "You owe $0.00".
- **Production-mode suites:**
  - control sweep: 882 real-pointer clicks on 56 role/page combinations, none covered, no errors
  - audit suite: all 71 scenarios passed
- **Dependencies and repository:**
  - `npm audit`: 0 vulnerabilities, production and all.
  - No secrets, keys or customer data files (CSV/XLSX) are tracked.

## Full check

`npm run check` was run with PostgreSQL 16 and Chromium (`ITTR_REQUIRE_DB_SUITES=1 ITTR_REQUIRE_BROWSER_SUITE=1`). Every required suite passed and none was skipped:
- production audit 215/215
- audit suite, all 72 scenarios including A46–A47
- control sweep: 882 real-pointer clicks on 56 role/page combinations, none covered
- smoke test, reporting v24.76.3

Two test-only corrections were needed along the way:
- The error-alert scenario now produces its server error with a real failure instead of a malformed id.
- A46 looks for the truck by name, not by a count.

## Not tested (to be done by the shop; see `docs/GO-LIVE.md`)

- the live Railway service, its variables, domain and replica count
- real phones and cameras
- real email (Resend/Gmail), SMS (Twilio), Stripe, R2 photo storage, Samsara and FMCSA accounts
- a backup restore rehearsal
- screen readers
- load

**This is not a full security review or penetration test, and it does not show that the platform is fully secure.**

## Deployment and rollback

- No migration and no new required settings. After deploy, `/api/health` and `/api/build` report **24.76.3**, and devices pick up service-worker cache `ittr-shopflow-v24.76.3`.
- **Rollback:** redeploy v24.76.2. No data is changed by this release.
