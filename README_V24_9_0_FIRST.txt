ITTR ShopFlow v24.9.0 — PRO SYSTEM AUDIT + UX HARDENING

DEPLOYMENT TARGET
- GitHub repository -> Railway
- Deploy over the SAME Railway service and SAME PostgreSQL database.
- DO NOT reset, recreate, wipe, or replace the production PostgreSQL database.

WHAT THIS RELEASE FIXES / HARDENS
1. Release identity consistency
   - Frontend, backend and package version are all 24.9.0.
   - Fixes the v24.8.2 package drift where backend reported 24.8.2 while frontend/package still reported 24.8.1.

2. Critical feature regression protection
   - Owner/admin Add Manager retained.
   - Owner/admin permanent invoice deletion retained with exact invoice-number confirmation and server audit entry.
   - Invoice void, line deletion, payment and PDF workflows retained.
   - Mechanic Truck Is Here, activity timing, completion flow and self-service workflow retained.
   - Workshop AI floating button/chat retained.
   - Fullbay customers, inventory and service-history imports retained.
   - Barcode, inventory count and Smart Vendor Receiving retained.

3. Manager permission hardening
   - Frontend view access now respects manager permission flags for invoices, customers, inventory, reports and employee management.
   - Employee management API now requires the manager employees permission.
   - Fullbay parts import now requires inventory permission.
   - Fullbay customers/service-history import now requires customers permission.
   - Owner-only manager creation/deletion remains owner/admin only.

4. Hands-free Workshop AI
   - Voice input now has explicit language selection:
     English (en-US), Ukrainian (uk-UA), Polish (pl-PL), Spanish (es-US), Russian (ru-RU).
   - Microphone visual pressed state and permission error feedback added.

5. Offline / sync visibility
   - Header sync badge shows pending cloud state mutations.
   - Offline state is clearly shown and pending count remains visible.
   - Existing offline banner retained.

6. Smart Vendor Receiving review
   - Uploaded PDF/image is shown side-by-side with parsed invoice data on desktop.
   - Mobile stacks document preview above editable parsed data.
   - Required part/quantity/vendor fields receive validation highlighting before inventory can be posted.
   - Existing atomic inventory receiving backend is retained.

7. Release regression audit
   - npm run audit checks critical routes/UI markers, frontend syntax, duplicate IDs/routes, root/public consistency, RBAC hardening, and the v23.7.1 Fullbay inventory SQL parameter fix.

BEFORE PUSHING TO GITHUB
1. npm install
2. npm run check
3. Verify .env is NOT committed. Use .env.example only.
4. Commit the complete release folder contents.

RAILWAY DEPLOY
1. Push to the GitHub branch connected to the existing Railway service.
2. Keep all existing Railway environment variables.
3. Keep the existing PostgreSQL service/database.
4. Do not run a destructive schema reset.
5. Railway start command is npm start (also covered by Procfile/railway.json where applicable).

POST-DEPLOY SMOKE TEST
1. Open /api/health and /api/build.
2. Confirm frontend/backend show 24.9.0 and there is no red version mismatch banner.
3. Owner/admin -> Operations -> Team Accounts & Permissions -> verify + Add Manager.
4. Open an unpaid invoice -> verify Void and owner/admin Delete Permanently are available.
5. Manager account with inventory disabled -> verify Parts is hidden/blocked.
6. Manager account with employees disabled -> verify account management is hidden/blocked.
7. Mechanic -> verify My Work Orders, Truck Is Here, Start Activity, labor/task work, and Complete Work Order.
8. Workshop AI -> verify lower-right button is visible; ask: коли була заміна масла на 6600?
9. Workshop AI voice -> test EN/UA/PL/ES/RU selector in Chrome/Edge where Web Speech API is supported.
10. Parts -> Smart Vendor Receiving -> upload a PDF/image -> verify side-by-side document + editable parsed data.
11. Disconnect Wi-Fi temporarily -> verify Offline banner and Sync badge.
12. Fullbay Data Center -> verify customer, parts and service-history tools load without database reset.

IMPORTANT ARCHITECTURE NOTE
The live ITTR application is currently a vanilla JavaScript/Express PWA, not React. This release intentionally does NOT perform an in-place React rewrite because mixing a framework migration with production accounting, inventory, work-order, AI and RBAC changes would materially increase regression risk. The recommended route/domain code-splitting migration should be done on a separate branch after v24.9.0 is deployed and smoke-tested.
