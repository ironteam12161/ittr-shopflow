ITTR v24.6.6 FIRST TEST

1. Deploy over the SAME Railway project and SAME PostgreSQL database. Do not reset data.
2. Keep existing environment variables. Optional tax-origin overrides:
   SHOP_TAX_CITY=Matteson
   SHOP_TAX_COUNTY=Cook
3. Hard refresh and verify frontend/backend 24.6.6.
4. Open a draft invoice.
5. Labor 1: choose Our client — $110/hr. Enter hours.
6. Add Part. Confirm Labor 1 values remain unchanged.
7. Search a part by part number, then by description. Select a suggestion and verify part #, description, sell price, cost and tax state populate.
8. Add Labor 2. It should inherit Labor 1's $110 rate.
9. Change Labor 2 to $60. Add Labor 3. Labor 3 must still inherit Labor 1's $110 rate.
10. Verify the IDOR tax panel loads an official Illinois rate. If a special-district/address warning appears, verify with the official finder before finalizing.
11. Type a manual tax rate and confirm Tax / Total / Balance update immediately.
12. Enter Shop Supplies, Environmental/Other Fee and Invoice Discount; verify live totals. Toggle fee taxable flags as appropriate.
13. Save Changes, reopen invoice, and verify all persisted values.
