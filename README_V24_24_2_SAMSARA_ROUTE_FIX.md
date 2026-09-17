# ITTR ShopFlow v24.24.2 — Samsara Route Registration Fix

Fixes the production `API endpoint not found` error from v24.24.1.

Root cause: the new Samsara unit-sync routes could be registered after the application's API fallback/404 middleware. Express therefore returned the generic API endpoint-not-found response before reaching the sync handlers.

Fix:
- Registers Samsara sync endpoints directly beside the existing `/api/samsara/fleet` integration routes.
- Adds `/api/samsara/integration-status` for deployment/configuration verification.
- Keeps VIN-first safe matching and unique unit-number fallback.
- Does not auto-create customers or units.
- No database reset.
- Existing Fullbay, invoice, work-order, service-history and barcode fixes retained.
