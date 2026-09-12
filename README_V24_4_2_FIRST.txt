ITTR ShopFlow v24.4.2 — Mobile UX + Smart Receiving Interface Audit

Deploy over the SAME Railway service and PostgreSQL database.
Do not reset PostgreSQL. Do not re-import Fullbay.

After deployment hard-refresh and verify /api/build reports 24.4.2 / 24.4.2.

Mobile checks:
1. Bottom navigation has Home, Work, Customers, Parts, More.
2. More opens Findings, Operations, Activity History and Mechanics.
3. Parts inventory is displayed as readable mobile cards.
4. Receive Vendor Invoice opens a phone-first upload screen.
5. Extracted invoice lines display as separate cards with clear labels for Part #, Description, Qty, Buy Price, Core and ITTR Match.
6. Sticky receiving confirmation remains accessible without covering the fields.
7. Existing v24.3.2 nested scanner/modal stacking behavior remains intact.
