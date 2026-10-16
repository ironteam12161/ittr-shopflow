# ITTR ShopFlow redesign plan (v24.69.0 →)

This plan splits the redesign into four phases, each shipped as its own reviewable PR. Phase 1 shipped in v24.69.0. Phases 2–4 shipped together in v24.70.0; sections 3–5 describe what was built,
the data each part reads or writes, how it is tested, and where the build differs from the original plan.
Nothing is deleted. Each existing screen keeps working until its replacement is in place and has been tested.

## 1. Research: what comparable shop systems document

| Capability | Documented by | Source |
|---|---|---|
| Inspection photos can be marked up with circles, arrows and text. The marked-up image is the one the customer sees. | Tekmetric | [DVI Image Markup](https://support.tekmetric.com/hc/en-us/articles/34327534094871-DVI-Image-Markup) |
| The technician's phone app is built around the job: rate each inspection item, add photos and video, add notes | Tekmetric | [Tekmetric Mobile](https://support.tekmetric.com/hc/en-us/articles/26781766611351-Tekmetric-Mobile) |
| Repair orders have a fixed set of statuses. Labels sit on top of them for workflow states the shop defines itself. | Tekmetric | [RO Labels and Workflow Statuses](https://support.tekmetric.com/hc/en-us/articles/360039292193-RO-Labels-and-Workflow-Statuses) |
| The dashboard tracks job holds: waiting on parts, waiting on customer, waiting on sublet, on hold | Tekmetric | [Shop Dashboard](https://support.tekmetric.com/hc/en-us/articles/360042280134-Shop-Dashboard-Real-Time-Reporting) |
| The technician app does inspections on the phone and can draw lines, text and arrows on photos and crop them | Shopmonkey | [Inspections in the techs app](https://help.shopmonkey.io/en/articles/6136382-how-do-i-perform-inspections-in-the-shopmonkey-for-techs-app), [techs mobile app](https://help.shopmonkey.io/en/articles/8887793-inspections-in-shopmonkey-for-techs-mobile-app) |
| Techs add notes and photos from the floor, advisors review them, customers see the images in a portal, and DVIR photos flow into the repair | Fullbay (marketing pages, not help-center articles) | [Work order management](https://www.fullbay.com/work-order-management/), [DVIR](https://www.fullbay.com/dvir/), [Customer communication](https://www.fullbay.com/products/customer-communication/) |

We found no official Fullbay help-center article that covers photo markup or board statuses. The Fullbay rows above
come from product marketing, so read them as claims about capability, not as documentation of how the feature works.

**Our own recommendations (not copied from any of the products above):**
- **Markup is stored next to the original photo; the original is never changed.** Tekmetric documents the opposite:
  the marked-up copy replaces the original in the customer report. For a heavy-truck shop the untouched original
  is evidence for warranty claims, disputes and DOT questions. We keep it, and draw the markup over it when the photo
  is shown.
- **A finding is never lost because a photo upload failed.** The finding is saved first. Photos are kept on the
  device and uploaded afterwards.
- **Statuses are fixed, and blockers are separate flags**, following the Tekmetric status-plus-label pattern. The
  board asks two questions: what stage is the job at, and what is holding it up?

## 2. Phase 1 — photos and design foundations (v24.69.0, shipped)

Delivered:
- `public/design-system.css` — shared design tokens and components:
  - Tokens: neutral surfaces, charcoal navigation, and the Iron Team accent kept for brand marks only. Blue means
    action, red means urgent, amber means attention, green means done.
  - Components: buttons, chips, alerts, empty states, skeletons, a focus ring, and 44px touch targets.
  - Every colour is paired with a text label.
- `public/icons.js` — one line-icon set, drawn for this app and loaded as an inline sprite. No external library.
- `public/photo-viewer.js` — full-screen photo viewer:
  - The photo fits the screen and is never cropped.
  - Zoom with the wheel, buttons, double-click or pinch, up to 8× the fit size. Pan by dragging. Rotate in 90° steps.
  - Previous/next with buttons, arrow keys or swipe. Other keys: `+` `−` `0` `R` `M` `Esc`.
  - Focus stays inside the viewer while it is open and goes back to the tile that opened it.
  - Shows the unit, component, mechanic, time and finding.
  - When a photo fails to load, it fetches a fresh signed link once, then shows a Retry.
  - Markup: arrows, circles and text in red, amber or white, with undo. Saved as data; the original photo is untouched.
- `public/photo-queue.js` — durable upload queue:
  - Photos are stored in IndexedDB per account and uploaded one at a time.
  - Each upload carries a client id, so a retry never stores the same photo twice.
  - States: Saving / **Saved on this device** (shown only after the IndexedDB write completes) / Not saved on this
    device / Uploading / Uploaded / Upload failed + Retry / Not accepted + Remove / Sign in to upload.
  - A failed upload retries automatically after 5 s, 15 s, 30 s, then every 60 s, and again when the connection
    comes back.
- Finding form and finding cards:
  - Several photos per finding, each with a caption and a type (Before repair, After repair or Close-up).
  - Tiles show small thumbnails, never cropped.
  - "Add photos" on existing findings, for the owner and the assigned mechanics.
  - "Compare before / after" when a finding has both types of photo.
- Server (`photo_center.mjs` and the existing routes in `server.js`):
  - Additive columns on `finding_photos`: `caption`, `kind`, `pair_id`, `component`, `annotations` (jsonb,
    default `[]`), `thumb_key`, `thumb_width`, `thumb_height`, `client_id`, `updated_at`, `updated_by`.
  - A partial unique index on `(finding_id, client_id)`.
  - Each upload also stores a 480px thumbnail. A failed thumbnail does not fail the upload.
  - New endpoints:
    - `GET /api/work-orders/:id/photos` — every photo of a work order, with thumbnail links, in one request.
    - `GET /api/photos/:id` — one photo, with full and thumbnail links.
    - `PATCH /api/photos/:id` — caption, component, type, before/after pair, markup. Allowed for the uploader or the
      owner, and audited.
  - `GET /api/photos/:id/url?variant=thumb` serves the thumbnail. Deleting a photo also deletes its thumbnail.
- Bug fixed: the customer inspection page showed photos that had been deleted. It now filters them out.

Unchanged on purpose:
- **Who can see photos.** The owner, plus the mechanics assigned to the work order (`canAccessPhotoWorkOrder`).
  Managers still cannot open photos. The new screens explain this instead of showing a broken image.
  Letting managers see photos is a product decision for the owner. One option is to tie it to a manager permission.
- Older photos stored inside the finding record as a data URL still show, labelled "Older photo".

## 3. Phase 2 — work-order page and mechanic job screen (v24.70.0)

**Office work-order page** (`public/shop-workspace.js`, address `#wo/<id>/<tab>`)
- For owner and manager accounts, opening a work order (from the board, the list, the calendar, search…) now opens a
  full page instead of the pop-up. The header shows unit, customer, parking, schedule, the board stage, blockers and
  the assigned mechanics. Tabs: **Jobs · Findings · Photos · Inspection · Time · Billing**.
- *Jobs* is the same detail markup as before (`workOrderDetailHtml`, extracted from `openDetail`), so every existing
  action — timers, parts, helpers, parking, edit, delete, complete — works unchanged. Those actions call `openDetail`
  again to refresh; for office accounts that now refreshes the page, so no pop-up appears.
- *Findings*: each finding with its approval lane, "Mark reviewed", and "Send findings to customer".
  *Photos*: every finding's gallery (phase 1 viewer). *Inspection*: the existing inspection card and repairs list.
  *Time*: per-job state and labor time with a total, plus the mechanic work summary. *Billing*: links to the existing
  service-order/invoice flow, Estimates and Invoices; hidden behind the Invoices permission for managers. No totals are
  computed on this page — invoice calculations are unchanged.
- The tab is in the address: reload keeps it, Back returns to where you came from, the browser tab shows the unit.

**Mechanic phone**
- The bottom bar stays **My Work · Start Job · Finding · History** (already role-specific). The plan proposed
  "Clock" and "More"; the time clock is the first card on My Work and Start Job/History are used daily, so replacing
  them would have hidden existing functions. Mechanics keep the job pop-up (it is built for the phone).
- Each job on the job screen has **Report a problem on this job**. It opens the finding form with the truck and the
  job filled in; the finding stores `taskUid` and `taskSnapshot` (job name) and every finding card shows
  "Found on job". The job screen ends with **Photos for this job** (the mechanic's findings with their photos).
- The finding form no longer jumps to another truck when a sync arrives while it is open.

## 4. Phase 3 — Repair Board and approval lanes (v24.70.0)

**Repair Board** (`#board`, Shop group). Stages are computed every time from the work order, never stored:

| Order | Stage | Rule (checked top to bottom, first match wins) |
|---|---|---|
| 1 | Ready | Work order Completed (shown for 36 h unless marked picked up) |
| 2 | Expected | Truck not here (`readyForMechanic` false) |
| 3 | Quality Check / Ready | Every job resolved (completed, not completed, next visit, or declined): Quality Check until `qc.passedAt` is set, then Ready |
| 4 | Repair | A job timer is running |
| 5 | Approval | A finding is Reported, in Office Review or waiting on the customer |
| 6 | Repair | Some job started or done, or the WO is In Progress |
| 7 | Diagnosis | Inspection started, or findings exist |
| 8 | Checked In | Truck here, nothing started |

- Cards: unit, WO #, customer, priority, mechanics, jobs done bar, running job, findings waiting, blockers, and the
  next step (Truck is here · Send to customer · QC passed · Reopen QC · Picked up). Search, mechanic filter, "Blocked
  only". On a phone: a stage picker and the stages that have trucks, stacked.
- **Blockers** (chips with who/when/why): Waiting on parts, Waiting on customer, Waiting on sublet, On hold (asks why).
  "Waiting on customer" is also shown automatically while findings sent to the customer are unanswered.
- **Waiting on parts** is shown automatically while a purchase order linked to the work order is Ordered or Partly
  received with parts still open (`GET /api/purchase-orders/open-by-work-order`; the PO number and vendor show only
  with the Parts & inventory permission). The office can also set it by hand.
- **Drag-and-drop** does what a button would do: Expected → Checked In (truck is here), Checked In → Expected (customer
  truck not started), Quality Check → Ready (QC passed), Ready → Quality Check (reopen QC). Because the other stages
  follow from the mechanic's work, dropping a card there explains what moves the truck instead of faking it. Every
  move also has a button, so keyboard and touch users are not left out.
- New optional fields: `wo.qc {passedAt, by, notes}`, `wo.blockers {parts|customer|sublet|hold: {on, by, at, note}}`,
  `wo.releasedAt/releasedBy`.

**Approval lanes** (Findings page, default view; "List by date" keeps the old list):
Reported → Office Review → Customer Approval → Approved / Declined → Job Created → Completed.
- Reported = waiting, not reviewed. Office Review = `officeReviewedAt` set. Customer Approval = `sentAt` set.
  Approved/Declined = the existing decision. Job Created = approved and converted to a WO task (`findingId`);
  Completed = that task resolved. Decided items show for 30 days; everything stays in "List by date".
- "Send to customer" opens the existing inspection customer link; once a link is created, the truck's open findings
  move to Customer Approval. Approve/Decline/Reopen use the existing decision endpoint (`applyFindingDecision`), so
  conversion to a job is unchanged.
- Server: a mechanic's save keeps `qc`, `blockers`, `releasedAt/By` and the findings' `officeReviewedAt/By`,
  `sentAt/By` exactly as they were, and a new finding from a mechanic always starts unreviewed and unsent.

## 5. Phase 4 — navigation, docked AI, tables (v24.70.0)

- **Sidebar** on desktop (≥ 1280px, owner/manager): **Shop** (Dashboard, Repair Board, Work Orders, Findings),
  **Customers & Units** (Customers & Vehicles, Compliance), **Parts** (Parts, Orders), **Money** (Estimates, Invoices,
  Bills, Reports), **Management** (Operations). Same views and permissions as before (`managerViewAllowed`).
  "Collapse menu" shrinks it to icons (names stay as tooltips) and is remembered per browser. Below 1280px the top
  bar and the phone bottom bar are unchanged; the phone "More" sheet gains Repair Board.
- **Docked AI panel** on desktop: when open it takes a 420px column on the right and the page narrows, so nothing is
  covered; toasts move left of it. Chat behaviour from v24.67 is unchanged. On phones it stays full-screen.
- **Tables**: list tables in the app get one look — sticky header, numbers right-aligned, and labelled cards on a
  phone. Editors (tables with inputs), print templates, pop-ups and tables that already have their own phone layout
  (work orders, parts) are left alone.
- **Invoices and estimates** now use the same column words — Qty / Hrs · Buy · Markup (under Buy on estimates) ·
  Sell / Rate · Tax · Line Total — and the invoice shows the same internal **Parts buy / Parts profit** summary as the
  estimate (display only, hidden in print and on the customer copy). They are still two editors in code; no invoice
  or estimate calculation changed (`invoice_check.mjs` and the invoice integration suites run unchanged).

## 6. Rollout and rollback

- **Database:** the migration only adds columns and one partial unique index, with `IF NOT EXISTS`, at startup
  (`ensurePhotoSchema`). Existing rows keep working: `annotations` defaults to `[]` and the other new columns are
  nullable. No backfill. Older photos have no thumbnail and show the full image as their tile.
- **Rollback:** deploy v24.68.0 again. The extra columns are ignored by the old code; thumbnails stay in the bucket
  (prefix `findings/…_t.jpg`) and can be deleted later. Photos uploaded with v24.69.0 still open in v24.68.0 (single
  photo per finding: the first one, via `photoId`). Photos still waiting in a phone's IndexedDB queue are uploaded
  when the phone runs v24.69.0 again; v24.68.0 does not read that queue.
- **Storage cost:** one extra JPEG of about 20–60 KB per photo.
- **No new services or dependencies.** `sharp` was already used. The test S3 server (`mock_s3.mjs`) is used only by
  the tests.

## 6b. Rollout and rollback (phases 2–4, v24.70.0)

- No database migration. New fields live in the shop record, are optional, and old code ignores them.
- Rollback: redeploy v24.69.0. Work orders open in the pop-up again, the board and lanes disappear, QC/blocker/
  review/sent flags stay in the record unused, and nothing else changes. Findings keep their `taskUid`.

## 7. Known limitations

- Managers cannot see photos (unchanged rule, see above) — a decision for the owner.
- Invoice and estimate editors share wording and the profit summary but are still two separate editors in code.
- The sidebar is for owner/manager accounts on screens ≥ 1280px; smaller screens keep the top bar.
- Drag-and-drop uses the browser's mouse drag; on touch screens the buttons on each card do the same.

Done since the first draft of this list (v24.70.0): photo caption/type/pair and delete in the viewer (uploader or
owner), text labels typed in the viewer, board drag-and-drop, "Waiting on parts" from purchase orders, an upload
time limit (a stalled upload goes back to Retry instead of blocking the photos behind it), and closing the viewer while
a photo is still loading no longer raises an error.
