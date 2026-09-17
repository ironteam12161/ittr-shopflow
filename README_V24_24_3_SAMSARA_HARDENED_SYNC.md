# v24.24.3 Samsara Hardened Sync
Production fix after v24.24.2 reached the route but returned a generic server error.

Changes:
- Removes assumptions about optional legacy `customer_units` columns during Samsara writes.
- Adds read-only Samsara diagnostics for token/API/database/schema checks.
- Adds a Check Connection button before Preview/Sync.
- Returns actionable admin-safe Samsara errors instead of only generic server errors.
- Keeps VIN-first matching, unique unit-number fallback, and no automatic duplicate creation.
- No database reset or destructive customer/unit changes.
