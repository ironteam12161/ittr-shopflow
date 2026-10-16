# ITTR ShopFlow redesign plan (v24.69.0 →)

This plan splits the redesign into four phases, each shipped as its own reviewable PR. Phase 1 is in v24.69.0.
Phases 2–4 below describe what has to be built, the data each part reads or writes, and how we will test it.
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

## 2. Phase 1 — photos and design foundations (v24.69.0, this PR)

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

## 3. Phase 2 — mechanic phone workspace and unified work-order workspace

**Mechanic phone (≤ 560px)**
- The bottom bar becomes four tabs: **My Work · Finding · Clock · More**. Tabs are role-specific, so mechanics never
  see office tabs.
- The job screen, top to bottom:
  1. Unit, customer and parking spot in one compact header.
  2. The task list. Each task has one big state button (Start / Pause / Done) and its elapsed time. The rules stay
     the same: clock-in first, one active task.
  3. "Report a problem", which opens the finding form from phase 1, pre-filled with the unit, the task and the
     component.
  4. Photos for this job (the phase 1 gallery).
  5. Parts used.
- Every write goes through the existing offline queue (`sync-queue.js`) and the photo queue. The banner states what
  is waiting.
- Data: no new fields. A finding gets an optional `taskUid` (additive), so the office can see which task a problem
  was found on.

**Unified work-order workspace (office, desktop)**
- One page per work order replaces the detail modal, the edit modal and the jumps between tabs. It has:
  - A header: unit, customer, stage, blockers, assigned mechanics, and links to the estimate and invoice.
  - Tabs: **Jobs** (tasks, labor, parts), **Findings** (phase 3 workspace, filtered to this WO), **Photos** (every
    photo of the WO, grouped by finding), **Inspection**, **Time** (task timers and clock history, read-only),
    **Billing** (estimate and invoice links with totals; the calculations stay in the invoice code).
- Back/forward and the URL keep working, for example `#wo/501/findings`. Each tab loads only its own data.
- Tests:
  - A browser suite opens each tab for the owner, a manager and a mechanic, and checks the permissions match today's.
  - Invoice totals are compared against `invoice_check.mjs` for the same work order.

## 4. Phase 3 — Repair Board and Findings/Approval workspace

**Repair Board stages** — computed from the existing fields; nothing new is stored for the stage itself:

| Stage | Rule (first match wins, evaluated right to left) |
|---|---|
| Expected | Not completed, truck not here (`truckHere` false and not in-house automatic) |
| Checked In | Truck here, no task started, no inspection started |
| Diagnosis | Inspection started (`inspection.startedAt`) or findings reported and none decided |
| Approval | At least one finding `Waiting for Customer` |
| Repair | Any task started and not all tasks done |
| Quality Check | All tasks done, `qc.passedAt` empty (new optional field `qc`: `{by, passedAt, notes}`) |
| Ready | All tasks done and QC passed (or QC not required for the customer), status not Completed |

**Blockers** are flags shown as chips on the card. They are separate from the stage, and a card can carry several:
- Waiting on parts: an open purchase order line for this WO, or a task part with no stock.
- Waiting on customer: a finding in `Waiting for Customer` for more than N hours.
- Waiting on sublet: a new optional `blockers.sublet` set by the office.
- On hold: a new optional `blockers.hold` with a reason.

Each blocker shows who set it and since when. The data changes are additive: `wo.blockers`, `wo.qc`.

**Findings / Approval workspace** — maps onto the existing `approval` field:

| Lane | Rule |
|---|---|
| Reported | `approval` Waiting for Customer and no `officeReviewedAt` |
| Office Review | office opened it: `officeReviewedAt` set (new optional field), not yet sent |
| Customer Approval | sent on an inspection customer link (existing `customer_links`) and still waiting |
| Approved / Declined | `approval` = Proceed / Do Not Proceed (existing decision code `applyFindingDecision`) |
| Job Created | `convertedToTask` true (existing conversion) |
| Completed | the created task is done |

- Decisions and the work-order conversion keep using `applyFindingDecision`, unchanged.
- The office can edit the professional text and price the repair before sending. The customer page shows the
  photos with their markup drawn on.
- Tests: an integration test walks a finding through every lane, and a browser test runs the board drag/drop and
  the keyboard alternative for each role.

## 5. Phase 4 — navigation, tables and invoice consistency

- **Sidebar on desktop**, grouped as **Shop** (Dashboard, Repair Board, Work Orders, Findings), **Customers & Units**,
  **Parts** (Parts, Orders, Cores), **Money** (Estimates, Invoices, Bills, Reports) and **Management** (Compliance,
  Operations, Team, Settings).
  - Same views and permissions as now (`managerViewAllowed`).
  - It collapses to icons with labels kept as tooltips and for screen readers.
- **Docked AI panel**: it docks to the right and shrinks the content instead of covering it. The chat behaviour from
  v24.67 (one conversation per account, cancel on sign-out) is unchanged.
- **Tables**: one table component for every list:
  - Sticky header, right-aligned numbers, the same sort and filter controls everywhere.
  - Rows become cards on a phone.
  - An empty state that says what to do next.
- **Invoices and estimates**: one layout. Buy price, markup and profit are shown the same way in both (v24.68 added
  this to estimates).
  - The calculations are untouched: `invoice_check.mjs` and the existing invoice tests must give identical totals.

## 6. Rollout and rollback (phase 1)

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

## 7. Known limitations after phase 1

- Managers cannot see photos (unchanged rule, see above).
- A photo's caption and type can be changed through the API (`PATCH /api/photos/:id`), but the viewer has no edit
  form for them yet. There is no UI for deleting an uploaded photo; the DELETE endpoint already existed before this
  release.
- "Compare before / after" uses the explicit pair when one is set, otherwise the first before and the first after
  photo. Setting a pair through the UI is part of phase 3.
- Text labels use the browser's prompt box; phase 2 replaces it with an inline field on the phone layout.
