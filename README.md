# ITTR ShopFlow v23.5

## v23.5 additions
- Historical mechanic productivity by day, week, and month using recorded PostgreSQL task time sessions.
- Per-mechanic audit drill-down with unit/task/session details.
- Free AI option through OpenRouter, with optional OpenAI fallback.
- Multilingual mechanic writing assistant that converts Ukrainian/other-language notes into professional American English without inventing repair facts.
- AI professionalization buttons in inspection findings and work-order completion notes.
- Safer parts cross-reference assistant with explicit verification labels/instructions.

### Recommended Railway AI variables
`OPENROUTER_API_KEY` = your private OpenRouter key
`AI_PROVIDER=openrouter`
`OPENROUTER_MODEL=openrouter/free`

Keep all AI keys server-side in Railway Variables. Never place them in `index.html`.

# ITTR ShopFlow v20.1 — Server Launch Fix

## IMPORTANT
Do NOT open `public/index.html` directly.

That creates a `file:///...` address and AI/API functions cannot reach the backend server.

### Windows startup
1. Extract the entire ZIP to a normal folder.
2. Double-click `START_ITTR_WINDOWS.bat`.
3. On the first run, it installs Node packages.
4. The platform opens at:
   http://localhost:3000
5. Keep the server command window open while using ITTR.

### AI setup
The core shop system can start without an AI key.

For AI translation, voice transcription, professional mechanic-note cleanup,
diagnostic assistance, part assistance, and VIN assistance:
- Open `.env`
- Recommended free AI: set `OPENROUTER_API_KEY=...`, `AI_PROVIDER=openrouter`, and `OPENROUTER_MODEL=openrouter/free`
- Optional OpenAI fallback / voice transcription: set `OPENAI_API_KEY=...`
- Restart the ITTR server

## v20.1 fixes
- Fixes generic "Failed to fetch" when public/index.html is opened directly.
- Adds a Windows launcher.
- Server now starts even when AI is not configured.
- AI endpoints return a clear setup message if no API key is configured.
- Adds dotenv so the `.env` file is actually loaded.
- Fixes the Express 5 SPA fallback route.
- Frontend detects `file://` mode and tells the user how to launch correctly.
- Bumps service-worker cache.

Existing v20 functionality is retained.
