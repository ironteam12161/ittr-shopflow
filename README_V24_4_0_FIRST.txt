ITTR ShopFlow v24.4.0 — Smart Vendor Receiving

Deploy over the SAME Railway project and PostgreSQL database.
Do NOT reset PostgreSQL. Do NOT re-import Fullbay.

New: Parts > Receive Vendor Invoice. Take a phone photo or upload an invoice, review AI-extracted lines, match existing parts or create new parts, then receive.

IMPORTANT: Invoice image/PDF scanning requires OPENAI_API_KEY on Railway because document/image understanding is performed server-side. Never place the key in frontend code or chat. Existing OpenRouter remains available for text AI.

After deploy hard-refresh and verify /api/build reports frontendExpected 24.4.0 and backend 24.4.0.
