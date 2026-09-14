# ITTR v24.17.1 Full Runtime Function Audit

Date: 2026-09-14
Base reviewed: v24.17.0 Labor + Nested Parts + Professional PDF

## Audit coverage

The deployed runtime was scanned across:
- 13 runtime HTML/JS/server files
- 600 named JavaScript functions (586 unique names)
- 298 inline UI event handlers
- 16 forms
- 114 Express routes
- 374 DOM IDs
- all standalone runtime JS/MJS syntax
- the main inline frontend script syntax
- release regression checks

This is a static/runtime-structure audit plus the project's regression suite. It does not replace
browser automation against a live production database, but it catches broken handler wiring,
duplicate routes/IDs/functions, syntax failures, navigation errors, and many security/performance risks.

## Confirmed bugs fixed in v24.17.1

### 1. Invoice opened in both a new tab and the original tab
Root cause:
`window.open(url, '_blank', 'noopener')` can return `null` even when the browser successfully opens
the new tab. The old code treated `null` as a popup-block failure and then executed `location.href=url`,
causing the original tab to navigate too.

Fix:
Invoice opening now uses a temporary `<a target="_blank" rel="noopener noreferrer">` and performs
exactly one navigation action. There is no same-tab fallback tied to an unreliable return value.

### 2. Add Manager button referenced a missing runtime function
`openManagerAccount()` existed in an older frontend bundle but was absent from the deployed runtime.
The Manager Account form was also present in the DOM without a submit handler.

Fix:
Restored `openManagerAccount()` and the manager form submit handler.

### 3. Workshop Manual Library referenced missing runtime functions
The production UI referenced `openManualLibrary()` and `openManualDocument()` while their runtime
implementations were missing. `manualLibraryForm` also had no submit handler.

Fix:
Restored:
- `openManualLibrary()`
- `loadManualLibrary()`
- `openWorkshopManual()`
- `openManualDocument()`
- `deleteWorkshopManual()`
- manual upload submit handling

Manual opening also uses a noopener/noreferrer link.

### 4. Runtime version markers were stale
Package version was newer than the visible frontend and `/api/build` markers.

Fix:
Frontend, backend build endpoint, package version, and audit expectations now report v24.17.1.

## Structural audit results

- Duplicate literal API routes: 0
- Duplicate DOM IDs in public/index.html: 0
- Undefined inline UI handler functions after repairs: 0
- Forms detected as present but unbound after repairs: 0
- Standalone JS/MJS syntax failures: 0
- Main inline frontend script syntax failures: 0
- Sensitive `/api/*` routes detected without auth middleware (excluding health/build): 0
- Root/public duplicate invoice/index files currently match
- `npm run check`: 155/155 passed

## Remaining architecture/security/performance findings

### High priority: Content Security Policy is disabled
Helmet still uses `contentSecurityPolicy:false`.
The frontend currently has approximately 158 `.innerHTML=` assignments and
9 `insertAdjacentHTML()` calls. Most reviewed invoice/parts output uses escaping,
but a future missed escape can become an XSS issue.

Recommended next step:
Move inline event handlers/scripts to modules, then enable a strict CSP.

### High priority: WebSocket session token is still passed in the URL
The shop-status WebSocket authenticates with a query-string token.
Query strings can be captured by reverse-proxy/access/diagnostic logs.

Recommended next step:
Issue short-lived single-use WebSocket tickets from an authenticated API endpoint.

### Medium/high: public/index.html is still a very large monolith
The deployed index is roughly 500 KB and contains hundreds of frontend functions.
This increases parse/compile cost and makes regressions harder to isolate.

Recommended next step:
Continue moving feature code into modules (`invoices.js`, `parts.js`, accounts, AI, manuals, work orders).

### Medium: startup still performs data-repair work
Legacy repair/normalization routines remain in startup.
As the database grows, deployments/restarts can take longer and may perform avoidable row-by-row work.

Recommended next step:
Convert historical repair routines into numbered one-time migrations.

### Medium: parts vendor loading can perform sequential resolver work
`/api/parts/vendors` can call `resolveVendor()` sequentially for up to 100 imported vendor rows.
That can become slow on a cold/uncanonicalized dataset.

Recommended next step:
Normalize vendors during import or resolve in one/batched database operation.

### Medium: inventory text search still includes `barcode_aliases::text ILIKE`
The major searchable columns have trigram indexes, but JSON text search can still cause scanning.

Recommended next step:
Normalize aliases into a dedicated indexed table or generated searchable text column.

### Medium: service worker unregisters itself
The current service worker deletes caches and unregisters itself. This is fine if offline PWA caching was
intentionally removed, but the remaining PWA shell can mislead future maintainers.

Recommended next step:
Either remove service-worker registration entirely or implement an intentional caching strategy.

## What was intentionally not changed in this build

The CSP migration, WebSocket ticket redesign, full frontend modularization, startup migration conversion,
and vendor/alias database redesign are larger architectural changes. They were not mixed into this
navigation/function-repair release to reduce regression risk.

## Validation commands

- `npm run check` -> 155/155 passed
- `node --check server.js` -> passed
- standalone runtime JS/MJS syntax scan -> passed
- extracted inline frontend JavaScript syntax scan -> passed
