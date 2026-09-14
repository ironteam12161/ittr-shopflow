ITTR ShopFlow v24.10.0 — PRO MOBILE / AI / RECEIVING / RESILIENCE
=================================================================

DEPLOYMENT TARGET
- GitHub -> existing Railway project
- Keep the existing PostgreSQL database and Railway environment variables.
- Do NOT create a new database or reset production data.
- Railway will install dependencies from package.json, including ws for the authenticated live-status WebSocket.

WHAT THIS RELEASE ADDS
1. Mechanic Self-Start Work Order
   - New touch-first 3-step wizard: DOT/VIN -> Customer/Truck -> Jobs.
   - Mechanic can start a walk-in job without an admin creating it first.
   - Server forces ownership to the logged-in mechanic and marks Truck Is Here.
   - DOT is now searchable in the customer/unit suggestion endpoint.

2. Touch-First Shop Floor UX
   - Primary mechanic controls use a minimum 52px tap target.
   - High-contrast Active/Paused/Waiting/Completed state tokens.
   - Mobile Start Job entry added to mechanic navigation.

3. Smart Vendor Receiving Dual-Pane OCR Review
   - 50/50 document + editable data workspace on larger screens.
   - PDF/JPG/PNG preview with zoom, scroll/pan and 90-degree rotation.
   - Yellow line warning when buy price is >5% above previous cost.
   - Missing part number and unlinked vendor validation.
   - Save Draft and Commit to Stock Inventory sticky actions.

4. AI Mobile + Voice
   - AI floating button is hidden while the chat is open.
   - Mobile AI chat uses a full 100dvh safe-area-aware viewport.
   - Streaming Web Speech dictation supports English, Ukrainian, Polish, Spanish and Russian.

5. Offline Sync Queue
   - Exact #sync-queue-badge status in the header.
   - Pending state mutations persist in localStorage under ittr_sync_queue_v2.
   - Reconnect automatically flushes queued state mutations to Railway/Postgres.

6. Runtime Resilience
   - Global toast notifications replace raw App error placeholder banners.
   - Authenticated /ws/shop-status live feed.
   - Exponential WebSocket reconnect (1s -> 2s -> 4s ... max 30s + jitter).
   - Live connection status shown in header.

PRESERVED / REGRESSION GUARDED
- Manager create/delete and permission gates.
- Owner permanent invoice delete and invoice void workflow.
- Fullbay customers, parts and service-history imports.
- Barcode scanning and physical inventory tools.
- v23.7.1 Fullbay inventory SQL fix: max placeholder remains $22; $23 is prohibited.
- v24.9.1 dynamic route modules and unmount cleanup.

VALIDATION
Run before deploying:
  npm run check

Expected result for this release:
  87/87 checks passed.

AFTER DEPLOY
1. Open /api/build and confirm frontendExpected/backend are both 24.10.0.
2. Sign in as a mechanic on a phone/tablet and test Start Job with a known DOT/VIN.
3. Open Workshop AI on mobile and confirm the floating AI button disappears while chat is open.
4. Test microphone permission and dictation.
5. Test Smart Receiving with a PDF or invoice photo before committing inventory.
6. Briefly disable Wi-Fi, make a permitted change, confirm Offline (X Pending), reconnect and confirm it returns to Synced.
