# v24.22.0 Invoice CSS Hard Fix
The live screenshot proved invoice markup was loading but invoice module CSS was not reliably active.
This release loads all invoice CSS globally from `/public/invoice-workspace.css` before invoice rendering, embeds an emergency grid fallback in the app shell, and synchronizes duplicate invoice module copies.
No database reset. No invoice math/history/AI changes.
