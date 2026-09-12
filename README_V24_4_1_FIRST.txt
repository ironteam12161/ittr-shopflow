ITTR ShopFlow v24.4.1 — Paid OpenRouter Invoice AI

Deploy over the SAME Railway project and SAME PostgreSQL database.
Do not reset PostgreSQL and do not re-import Fullbay.

Required Railway variable:
OPENROUTER_API_KEY=<your existing OpenRouter key>

Recommended:
AI_PROVIDER=openrouter
OPENROUTER_MODEL=google/gemini-2.5-flash-lite
OPENROUTER_INVOICE_MODEL=google/gemini-2.5-flash-lite
OPENROUTER_INVOICE_FALLBACK_MODEL=google/gemini-2.5-flash

Do not put API keys in frontend files or chat.
After deployment hard-refresh and verify /api/build shows 24.4.1 / 24.4.1.
Test Parts > Receive Vendor Invoice with one real invoice and review every extracted line before receiving.
