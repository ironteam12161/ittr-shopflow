# ITTR v24.23.2 — Merge Request Fix

Root cause confirmed: the Review Merge frontend called `apiJSON()` with a JavaScript object as `fetch()` body. ITTR's `apiJSON()` previously expected an already-stringified JSON body. The browser therefore sent `[object Object]`; Express rejected the request before the merge-preview route could run, which is why the route's new stage-specific error never appeared.

Fixes:
- Review Merge uses `JSON.stringify({masterId, duplicateId})`.
- Final Merge uses the same correct JSON serialization.
- `apiJSON()` now safely auto-stringifies plain-object bodies to prevent this class of bug in future lazy modules.
- Existing string, FormData and Blob bodies remain supported.
- No DB reset or schema migration.
