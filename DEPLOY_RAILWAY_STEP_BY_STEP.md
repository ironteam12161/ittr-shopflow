# ITTR v21 Online Beta — Railway deployment

## What is already done in this package
- Node/Express server prepared for a public HTTPS host.
- PostgreSQL connection through `DATABASE_URL`.
- Server-side login with bcrypt password hashing.
- Random server sessions; tokens are stored only in sessionStorage and hashed in PostgreSQL.
- Admin can create/delete mechanic login accounts and change mechanic passwords.
- Existing ITTR browser data can be migrated into the new cloud database on first admin login.
- Work orders, findings, users/activity profile data, and Professional Operations data are synced to PostgreSQL.
- OpenAI key stays server-side.
- Health check `/api/health` is configured.
- Railway configuration is included.

## Your steps
1. Create a private GitHub repository named `ittr-shopflow`.
2. Upload the CONTENTS of this folder to that repository (not the ZIP itself).
3. In Railway, create a New Project -> Deploy from GitHub Repo -> select `ittr-shopflow`.
4. In that Railway project, click New -> Database -> PostgreSQL.
5. Open the ITTR web service -> Variables and add/reference:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Railway may add/reference this automatically if the DB is linked)
   - `NODE_ENV` = `production`
   - `BOOTSTRAP_ADMIN_USERNAME` = `admin` (or your preferred admin username)
   - `BOOTSTRAP_ADMIN_PASSWORD` = a NEW strong password, at least 10 characters
   - `SESSION_TTL_DAYS` = `7`
   - `OPENROUTER_API_KEY` = your private OpenRouter key (recommended free AI)
   - `AI_PROVIDER` = `openrouter`
   - `OPENROUTER_MODEL` = `openrouter/free`
   - `OPENAI_API_KEY` = optional fallback and required only for the existing voice-transcription route
   - `OPENAI_TEXT_MODEL` = `gpt-5.6-luna`
   - `OPENAI_TRANSCRIBE_MODEL` = `gpt-4o-transcribe`
6. Redeploy/restart the service after variables are saved.
7. Railway -> service -> Settings/Networking -> Generate Domain.
8. Open the generated HTTPS URL.
9. Sign in with the bootstrap admin username/password from step 5.
10. On first login, if this browser has your old local ITTR data, the app asks whether to upload it to the cloud. Choose OK only on the computer containing the data you want to keep.
11. Admin -> Mechanic Accounts: create each mechanic account with a temporary password. Give each mechanic only their own username/password.
12. Test with two devices: create/edit a test work order on one, then refresh the other and verify it appears.

## Important beta limitation
v21 keeps the existing large frontend and synchronizes its legacy state snapshots into PostgreSQL. This makes the current program usable online quickly, but simultaneous edits to the exact same data from multiple devices are still a possible conflict. Do not treat this beta as the final production accounting/record system until v22 moves work orders/tasks/findings into transactional per-record API endpoints.

## Security rules
- Never commit `.env` to GitHub.
- Never put `OPENROUTER_API_KEY` or `OPENAI_API_KEY` in `index.html` / `public/index.html`.
- Never reuse the API key that was previously exposed.
- Use a unique strong bootstrap admin password.
- Keep the GitHub repository private.
