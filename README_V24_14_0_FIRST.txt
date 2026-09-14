ITTR ShopFlow v24.14.0

Deploy over the SAME Railway service and SAME PostgreSQL database.
DO NOT reset, recreate, or wipe PostgreSQL.

Invoice workflow is now a compact service grid:
Service -> Labor -> Parts -> additional Labor -> Service Subtotal.

Run before deployment:
  npm install
  npm run check

After deployment smoke-test:
1. Open an existing invoice.
2. Verify Customer/Unit/VIN/USDOT.
3. Add a Service.
4. Add a Part under that service.
5. Add another Labor line.
6. Confirm rate presets ($115/$110/$100/$60/Custom).
7. Verify Cost vs Selling Price.
8. Toggle Taxable and discount.
9. Save, print/PDF, payment and owner delete.
10. Verify AI and Fullbay tools still work.
