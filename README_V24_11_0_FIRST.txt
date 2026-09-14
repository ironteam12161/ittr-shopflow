ITTR ShopFlow v24.11.0 — Invoice + AI Workflow Repair

Highlights:
- Invoice editor now separates Labor & Services from Parts & Materials.
- Labor hours, labor/service subtotal and parts/materials subtotal are shown automatically.
- Per-line Taxable checkbox plus fixed-$ or percentage discount.
- Owner/Admin permanent invoice deletion is visible for old, paid and void invoices (backend confirmation and audit retained).
- Print stylesheet removes app chrome for customer-ready printing.
- Workshop AI chat send function restored; v24.10.0 UI referenced a missing sendShopAI() function.
- AI Writing Assistant uses live Web Speech dictation in English, Ukrainian, Polish, Spanish and Russian.
- AI buttons lock and show visual analyzing states while API calls run.
- Part cross-reference always shows OEM-fitment verification warning.

Deployment:
Deploy over the existing Railway project/database. Do not reset PostgreSQL. Startup schema migration is additive and safe.
