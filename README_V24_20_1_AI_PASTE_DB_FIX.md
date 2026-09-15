# ITTR ShopFlow v24.21.1 — AI Paste + DB Fix

Fixes the AI import error `column "buy_price" does not exist`. The actual inventory table uses `cost` and `price`; AI enrichment now aliases those correctly.

Workshop AI now supports:
- Ctrl+V screenshot/image paste directly into the chat input
- drag/drop image/PDF/CSV
- existing + file attachment
- normal pasted text without interception
- the existing Review → Create Draft Invoice safety flow

No database reset or migration required.
