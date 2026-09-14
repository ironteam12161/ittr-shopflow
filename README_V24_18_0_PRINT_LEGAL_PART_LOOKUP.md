# ITTR ShopFlow v24.18.0

Targeted invoice print/PDF and parts-search UX release.

## Fixed
- Expanded inventory part autocomplete uses viewport-level fixed positioning so results are not clipped by service cards or invoice panels.
- Search result cards show full part number, full description, stored selling price, buy cost, available quantity, and location.
- Browser print invoice uses one consistent five-column Labor / Parts table grid for Type, Description, Qty/Hrs, Rate/Price, and Amount.
- Server-generated PDF uses matching column guides for stronger alignment.
- Customer-facing invoice footer now includes warranty/repair authorization, manufacturer warranty language, authorization to perform repairs and purchase materials, loss/delay limitation language, antifreeze/freezing language, vehicle test/inspection authorization, mechanic's lien language, 50-mile wheel torque safety notice, and customer signature / printed name / date lines.
- Legal block is kept together when possible and moves to a new PDF page when necessary.

## Deployment
Deploy over the existing Railway service and existing PostgreSQL database. No database reset or destructive migration is required.

Run before deploy:

    npm install
    npm run check

Expected audit result: 192/192.
