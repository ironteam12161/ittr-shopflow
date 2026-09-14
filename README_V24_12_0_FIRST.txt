ITTR ShopFlow v24.12.0 — Professional Invoice UX

DEPLOYMENT
1. Deploy this package over the existing GitHub/Railway project.
2. Keep the existing PostgreSQL database. Do NOT reset or recreate it.
3. The v24.12.0 invoice migration is additive and runs safely with existing invoice data.
4. Confirm Railway reports frontend/backend 24.12.0 after deploy.

INVOICE CHANGES
- Customer selector + customer-linked Unit/Truck dropdown.
- VIN and USDOT auto-fill from the selected truck/customer.
- Mileage remains editable for the invoice visit.
- Separate Labor & Services and Parts & Materials billing sections.
- Parts default taxable; Labor defaults non-taxable; every row can override.
- Per-row $/% discounts remain supported.
- Global $/% invoice discount added.
- Due on Receipt / Net 15 / Net 30 / Net 60 with live due-date calculation.
- Real-time browser totals mirror server-side taxable-line math.
- Customer-ready print layout and PDF billing identity improvements.
- Existing owner invoice deletion, AI, Fullbay, mechanic, offline and PWA fixes preserved.
