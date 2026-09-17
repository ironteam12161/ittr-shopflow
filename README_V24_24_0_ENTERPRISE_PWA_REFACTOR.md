# ITTR ShopFlow v24.24.0 — Enterprise PWA Refactor

Applied to v24.23.4 production-readiness base.

- One-click invoice synchronization from a linked/selected Work Order. Transactionally rebuilds invoice labor from mechanic time sessions and assigned task parts while preserving invoice header, fees, payments, and customer data.
- Fleet pricing tiers: Retail (30% parts markup), Preferred (20% markup + 5% global discount), National Fleet (15% markup + 10% global discount). Review/confirmation required before repricing.
- Existing partial payment ledger/running balance and clean print/PDF behavior retained.
- Shop-floor touch contract: >=52px, 16px type, 16px padding for high-frequency mechanic actions.
- State tokens: Emerald active, Amber paused, Rose hold, Indigo complete.
- Smart Vendor Receiving 50/50 workspace retained and audited: PDF/image viewer, zoom/reset/rotate, editable OCR rows, >5% historical cost warning.
- Web Speech AI dictation retained for EN/UA/PL/ES and microphone accessibility improved.
- Fixed sync badge CSS selector mismatch.
- Replaced self-removing service worker with a production shell-cache PWA service worker. API requests are never cached.
- Persistent local state mutation queue remains source of offline writes; Background Sync requests a flush when supported, and browser online events flush on reconnect.
- Floating toast manager retained; no raw #app-error placeholder.
- Fullbay inventory $22 regression guard, Samsara, barcode aliases, invoice service history, RBAC, and prior fixes preserved.
- No database reset. One additive idempotent column: customer_invoices.fleet_tier.
