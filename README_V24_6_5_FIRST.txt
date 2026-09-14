ITTR v24.6.5
Deploy over the SAME Railway project and SAME PostgreSQL database.
Do NOT reset PostgreSQL and do NOT re-import Fullbay data.
After deploy hard refresh and confirm frontend/backend 24.6.5.

First tests:
1. Open invoice. Set Labor 1 to Old Client $100. Add Labor 2: it should start at $100.
2. Change Labor 2 to Custom $125. Add Labor 3: it should still start at $100.
3. Type a part number OR description; select inventory suggestion and confirm description/part#/sell price/cost fill together.
4. Type labor text, then press +Part. Labor text must remain.
5. Change tax rate/fees/discount: totals must preview immediately. Save and reopen to confirm server calculation persists.
6. Toggle Tax Exempt and save: server tax must be $0.00.
7. Use Get Current Illinois Rate. If the IDOR jurisdiction requires address-specific lookup, use the official MyTax link; ITTR intentionally does not guess.
8. Open a Unit > Service History and verify ITTR invoice appears with amount and Open action.
9. Generate PDF and verify logo, labor/parts grouping, totals, parts warranty note and 50-mile wheel/tire recheck notice.
10. Draft invoice can be permanently deleted. Finalized invoice must be voided; paid invoice can be reopened only with a correction reason.
