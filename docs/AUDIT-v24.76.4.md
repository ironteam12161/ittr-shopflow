# ITTR ShopFlow v24.76.4: UX and engineering audit

**Question:** looked at as a senior developer and a UX designer, what in the website gets in the way of the people using it, and what in the code will get in the way of the people maintaining it?

**Baseline:** `main` at `145723a` (v24.76.3, PR #86 merged).

**How it was tested:**
- **The shop:** a believable test shop on a local production-mode server (`NODE_ENV=production`, empty PostgreSQL 16 database), all synthetic data:
  - 6 fleet customers with 10 units, 12 parts
  - 7 work orders in every stage, 2 findings
  - invoices in every state: draft, sent, overdue, part-paid, paid
  - 3 estimates, 2 bills, a purchase order
  - an owner, an office manager and 3 mechanics
- **Screens:** every screen was captured and measured in Chromium, 44 screens in all:
  - an office desktop (1366 px): owner, all 17 pages, the work-order workspace and dialogs, the invoice and estimate editors, payment, customer profile
  - a tablet (820 px, touch): office manager
  - a phone (iPhone 13 profile): mechanic and owner
- **What was measured:**
  - **Contrast:** WCAG ratios for text against its real background.
  - **Size:** text under 12 px, and tap targets under 32 px.
  - **Structure:** heading order.
  - **Overflow:** sideways scrolling.
  - **Speed:** page weight, requests, and time to a usable app.
  - **Errors:** console errors.
- **The invoice lines** were measured separately, because invoicing happens every day:
  - in the editor dialog and in the workspace tab
  - at 11 widths from 390 to 1920 px
  - with ordinary values and with worst-case values (112.25 h, $2,345.67 parts, five-figure line totals, a sublet line)
- **The code:** read for structure, maintainability and risk.
- **Not contacted:** production. No real email, SMS, payment or AI provider was called.

## Findings and fixes

| # | Finding | Severity | Fix | Test (fails on v24.76.3) |
|---|---|---|---|---|
| U1 | **Invoice lines were cut off on laptop screens.** The one-line grid needs about 1,100 px, but the line-items card beside the summary is 656–1,024 px wide on 1024–1440 px screens.<br>**In the editor dialog**, the line total and the "•••" (remove line) button were outside the card on every line at every measured width from 1101 to 1600 px. The card hides overflow, so they could not be seen or clicked. The heading row wrapped, so "Actions" sat on a second line. Even at 1920 px the part line total was clipped.<br>**In the workspace tab** at 1101–1366 px, the line total and "•••" ran underneath the summary panel.<br>**On a 390 px phone**, the discount field was cut off.<br>**Inside the boxes**, values were cut: markup "85.4" showed as "8", and the discount "$" was hidden. | **P1**: invoicing is daily work; totals and the remove button were missing on common laptop sizes | The line layout now follows the card's own width, not the window's (CSS container queries), in both the dialog and the workspace tab:<br>• 800 px and wider: one line with column headings<br>• 540–799 px: four columns<br>• narrower: two columns<br>In the stacked layouts each value carries its own label (Hours, Rate, Buy, Markup, Sell, Discount, Line total).<br>In the one-line layout, compact boxes make every value readable. The number spinners are hidden there because they covered the value; the arrow keys still step it.<br>Screen only: the printed invoice keeps its own layout. | **A48** (new): every control on every line is inside the visible card, not overlapped, not covered, its value readable, no sideways scroll. Checked at 8 widths × 2 modes, never scrolling sideways. **A43** (strengthened): see U14. |
| U2 | **The invoice dialog scrolled sideways below 1,250 px.** It was 98% of the window wide inside 18 px of padding, so 16–20 px too wide. This was there before this audit. | P2 | It fills the space inside the padding. | A48 |
| U3 | **The estimate editor did not fit a phone.** On a 390 px screen it was 481 px wide and scrolled sideways. PO #, VIN, Valid until, the labor rate, "+ Canned job" and more were off the screen. The grids used `1fr` columns, which cannot shrink below an input's natural width. | P2 | The grid columns can shrink, and the add-job row wraps. | **A51** (new) |
| U4 | **Nothing was compressed.** `index.html` is 941 KB and is fetched in full on every app open (it is never cached, so updates reach every device). Each open moved **1,741 KB** in 31 requests, which is slow on a phone in the shop yard. | P2 | Pages, scripts and styles are sent with brotli (or gzip) using Node's own `zlib`: no new dependency, no new service.<br>Each file is compressed once per version and kept in memory. Caching rules are unchanged (the app page and screen modules stay `no-store`).<br>Range requests, small files and browsers that do not ask for compression get the file as it is.<br>Only plain files inside `public/` are looked up. | **A49** (new): the decompressed bytes equal the file; brotli, gzip and plain each work; HEAD, 304, range and cache headers behave; `..`, encoded `..` and dot-files reveal nothing outside `public/`. |
| U5 | **Low-contrast text:**<br>• white on light green (#12b76a) is **2.6:1** on "Clock In", the payment dialog's "Record payment" and the green confirm button<br>• grey "No jobs" in the calendar is **2.58:1** | P2 (Clock In is the first thing a mechanic taps, often outside in daylight) | • Buttons use the app's own `--ok` green (#067647): 5.7:1<br>• "No jobs" uses #667085: 4.8:1 | **A50** (new) |
| U6 | **On a mechanic's phone the floating AI button covered the work.** At rest it sat over the first job's status pill. While scrolling it covered the right end of every "Open Job" button, so a tap there opened the assistant. | P2 (gloved taps) | Mechanics on a phone reach the assistant from the bottom bar ("✦ Ask AI", 5 items like the office bar). The floating button stays on desktops and for the office. | A50 |
| U7 | Status pills ("In Progress", "Waiting Parts", "Assigned to you") were **11 px on phones**. | P3 | 12.5 px on phones. | A50 |
| U8 | **Overdue days were off by one.** An invoice due 20 days ago showed "Overdue 19 d" in the invoice list but 20 days in A/R aging. The list counted from the end of the due day; A/R aging counts calendar days (`CURRENT_DATE - due_date`). | P3 (two numbers for one invoice) | The list counts calendar days, the same way as A/R aging. | A50 |
| U9 | **Dashboard headings out of order.** "Mechanic Live Status" (H2) came before the page's only H1, "Shop Calendar". | P3 (screen readers) | A page title "Dashboard" for screen readers, and both sections as H2. Nothing changes visually except "Shop Calendar" now matching its sibling heading. | A50 |
| U10 | **The customer profile showed the customer's name twice**, as two identical headings (the dialog title and the profile header). | P3 | Named once, in the dialog title. That is also the dialog's name for screen readers. | A50 |
| U11 | Bills category filters were **26 px tall**, hard to tap on a tablet. | P3 | 34 px, and 40 px on touch screens. | A50 |
| U12 | The "•••" remove-line buttons were read aloud as "bullet bullet bullet". | P3 (screen readers) | They are named "Remove line" and "Remove labor". | A48 |
| U13 | **Wording on the mechanic's phone:**<br>• the subtitle under "My Work Orders" was a developer description ("Touch-first mechanic workspace")<br>• "Start Job" in the bottom bar was not translated into Ukrainian | P3 | • "Your jobs and all shop work" (UA: "Ваші роботи та вся робота майстерні")<br>• "Почати роботу"; "Ask AI" is "Запитати AI" | language switch audit |
| U14 | **A test gap let U1 through.** A43 ("every invoice control can be reached by the pointer") passed while the controls were cut off: `scrollIntoView` scrolls a box with hidden overflow, which a person cannot do. | (test) | A43 now reports a control that only a script can scroll into view. A48 never scrolls sideways at all. | A43 fails on v24.76.3 |
| U15 | **V4 depended on how many sign-ins came before it.** Every sign-in in the suite counts against one shared limit per address: 100 signed-out `/api/auth` calls per 15 minutes. V4 runs last and compares an unknown-user sign-in with a wrong-password one. With this release's four extra browser sign-ins, the first of the pair was call 100 (401) and the second call 101 (429), so the first full check failed. Reproduced on its own: 99 sign-ins, then the pair, gives 401 and 429. | (test) | V4's sign-ins come from their own address (the server trusts one proxy hop, as behind Railway's proxy), so its limiter buckets start empty. The scenario still checks the same things. The limit itself is unchanged. | reproduction script: 401/429 before, 401/401 after |

Each new or strengthened scenario (A43, A48, A49, A50, A51) was run against v24.76.3's app code, with the tests kept and the app files put back. Each one failed, and each passes on this branch.

## Measured before and after

Seeded shop, local production-mode server, Chromium.

| | v24.76.3 | v24.76.4 |
|---|---|---|
| Data per app open (desktop owner, 31 requests) | 1,741 KB | **525 KB** (−70%) |
| `index.html` on the wire | 941 KB | **203 KB** (brotli) |
| Text failing WCAG contrast, 44 screens | 3 | **0** |
| Invoice line controls cut off, covered or unreadable (8 widths × 2 modes, worst-case values) | 10–15 per width in the dialog at 1101–1440 px (2 at 1600 and 1920); total and ••• under the summary in the workspace tab at 1101–1366 px | **0** |
| Estimate editor on a 390 px phone | 113 px too wide, 16 controls off-screen | fits |
| Console errors, all roles and devices | 0 | 0 |
| App usable after sign-in | ~0.45 s | ~0.45 s |

## Checked and found sound

- **No errors:** no console errors, failed requests or 4xx/5xx responses on any of the 44 screens, for the owner, office manager or mechanic.
- **No page-level sideways scrolling** on any screen at 390, 820 or 1366 px. The two sideways scrolls found (U2, U3) were inside dialogs.
- **Speed:** sign-in to a usable app takes about 0.45 s locally, on every device profile.
- **Contrast and size:** after the fixes, all text on the 44 screens meets WCAG contrast. On touch screens, everything reported as a small target is a text label above a full-size field, except two 18 px checkboxes (below).
- **Mechanic phone:** headings, Clock In, the job cards and the bottom bar work in English and Ukrainian.

## Not changed: UX backlog (recommendations)

These are design choices or larger changes. They are not defects that block work, so they are left for the owner to decide.

1. **The 2-step-login reminder** is a toast in the lower right for about 9 s after each owner or manager sign-in, until 2-step login is turned on. It covers whatever is there, but a tap dismisses it. Consider a dismissible line in the account menu instead, or showing it once a day. Not changed: it is a security nudge, so how often it appears is a product decision.
2. **The dashboard has no at-a-glance numbers.** Consider a strip with open work orders, trucks ready to invoice, and overdue A/R.
3. **"Admin ADMIN" in the header** is the bootstrap display name "Admin" next to the role badge. Set the owner's real name under Accounts. Consider showing "OWNER" for the admin role.
4. **Desktop table headings** are 10–11 px uppercase (most of the 155 small-text items). This is conventional for column labels; 12 px would read better.
5. **On a tablet**, the invoice totals sit below the line items (one column under 980 px), so you scroll to see the Grand total. Consider a sticky total bar.
6. **On phones, the Repair Board** columns scroll sideways with no visual cue. The "Blockers" button looks like plain text.
7. **Two 18 px checkboxes** on touch screens: Board selection and "Select part" in Parts.
8. **Long part numbers** (for example `TK-102-1234-XL`) scroll inside the Part # box on invoice lines below about 1440 px. A long customer email does the same in the estimate header.
9. **The sidebar uses text characters as icons** (▦ ▤ ⌕ $), although the app has an icon set (`icons.js`).
10. **"+ Start New Job" on the mechanic's home** repeats "Start Job" in the bottom bar. Kept on purpose: it is the main call to action at the top of the page.

## Code and architecture review

What will cost the most as the shop grows, in order:

1. **The whole shop is one document.** Work orders, findings and users live in one JSON record (`app_state`). Every device reads it on every app open and writes it back whole on save. Version checks and field-level merges keep concurrent saves safe.
   - **The cost:** the record grows with every work order kept in it. In the test shop, `/api/state` was 4.6 KB with 7 work orders. A year of a busy shop's history would make every open and every save slower, especially on phones.
   - **What already exists:** since v24.56 a database trigger copies every work order into its own `work_orders` table, and it was built so reads can move there step by step.
   - **Recommendation:** keep only open work in the live document, read history from `work_orders`, and measure `/api/state` on the live database before and after.
   - Not changed here: it is a data-model change and needs its own release and testing.
2. **Very large single files.**
   - `server.js`: 616 KB, 5,486 lines, 180 routes.
   - `public/index.html`: 943 KB, with 16 `<style>` and 17 `<script>` blocks.
   - **The cost:** reviews are hard and merge conflicts likely. Every visit downloads all screens' code; compression (U4) cuts the bytes, not the parse time.
   - **Recommendation:** keep moving areas into modules, as was done for invoices, estimates, bills, purchase orders and reports.
3. **About 460 inline event handlers** (`onclick=` and similar) in `index.html`. They force the Content-Security-Policy to allow `'unsafe-inline'` scripts, which weakens the main defence against injected script. The inline-handler guard stops raw values from being put into them.
   - **Recommendation:** move to delegated listeners (`data-action`) screen by screen, then drop `'unsafe-inline'` from `script-src-attr`.
4. **The invoice styles are layered with `!important`.**
   - The rules exist twice: in `invoice-workspace.css` and in `modules/invoices.html`.
   - `!important` count: 1,686 in `invoice-workspace.css`, 1,505 in `modules/invoices.html`, 513 in `index.html`.
   - Rules from v24.16 to v24.43 override each other, by window width, in both places. This is why U1 survived several fixes.
   - This release adds one final screen-only block that decides the line layout by the card's width. The old rules are left in place to avoid regressions in print.
   - **Recommendation:** consolidate the invoice screen styles into that one block, keep the print styles separate, and delete the rest.
5. **Mirrored copies.** The root `index.html`, `sw.js` and `modules/` are byte-for-byte copies of the files under `public/`. Every change has to be made twice; the tests catch a missed copy, but it is easy to forget. Consider generating the copies, or removing them if nothing serves them.
6. **Two large unreferenced files** in the repository root: `frontend_check_2471.js` (334 KB) and `frontend_check_2481.js` (342 KB). Nothing in `package.json`, CI or the code references them; `npm run check` uses `frontend_check.js`. They are candidates for removal. Not deleted here.
7. **Large API answers are not compressed.** The measured answers were small (under 8 KB), so it was not worth the risk in this release. Revisit together with item 1, once real sizes are known.

## Full check

`npm run check` was run with PostgreSQL 16 and Chromium (`ITTR_REQUIRE_DB_SUITES=1 ITTR_REQUIRE_BROWSER_SUITE=1`). It exited 0. All 24 required suites passed and none was skipped:
- production audit 215/215
- audit suite: all 76 scenarios, including A43 and A48–A51
- control sweep: 882 real-pointer clicks on 56 role/page combinations, none covered, no sideways scrolling
- smoke test, reporting v24.76.4

The first full run of this release failed in V4 (U15, a test problem). V4 was fixed, and the run above is a complete re-run from the start, not a partial one.

## Not tested

- the live Railway service and its settings, including whether its edge already compresses responses (the app's compression is safe either way: a proxy does not compress a response twice)
- real phones and tablets (device profiles in Chromium only), and Safari/iOS rendering of container queries (supported since Safari 16)
- screen readers (only the accessibility tree and headings were checked)
- real email, SMS, Stripe, R2 and Samsara accounts

This audit is about usability and maintainability. It is not a security review, and it does not show the platform is fully secure or completely tested.

## Deploy / rollback

- No migration and no new settings.
- After deploy, `/api/health` and `/api/build` report 24.76.4, and devices pick up the `ittr-shopflow-v24.76.4` cache.
- Responses for pages, scripts and styles carry `Content-Encoding: br` (or `gzip`).
- To roll back, redeploy v24.76.3.
