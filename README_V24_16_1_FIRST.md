# ITTR ShopFlow v24.16.1 — Invoice Tab Autosave + Production Hardening

This package is based on the uploaded v24.16.0 INVOICE_TAB_AUTOSAVE_AUDIT build and preserves its invoice-tab autosave/draft behavior.

Applied hardening/performance changes:
- Static web serving is restricted to `/public` rather than the repository root.
- Current autosave frontend and route modules are synchronized into `/public`.
- Login attempts are limited to 10 failed attempts per 15 minutes.
- `/api/parts` is read-only and no longer performs per-result barcode SELECT/UPDATE work.
- Parts search ranks exact and prefix matches before looser matches.
- Optional PostgreSQL `pg_trgm` indexes are created for common part-search fields.
- Production HTTP 500 responses no longer return internal database/server exception text.
- Health/build metadata updated to v24.16.1.
- Optional SQL migration included at `database/v24_16_1_parts_search_performance.sql`.

Important:
- CSP remains disabled because the legacy frontend still contains inline handlers. Enabling strict CSP safely requires a separate frontend refactor.
- WebSocket authentication still uses the existing session-token query-string behavior to avoid breaking live shop status. A short-lived WS-ticket migration should be done separately.
- The root copies of frontend files are retained for source/history compatibility, but Express serves only `/public`.

Validation:
Run:
    npm install
    npm run check

Deployment:
The package remains structured for GitHub/Railway deployment. Ensure `DATABASE_URL` and the existing required environment variables are configured.
