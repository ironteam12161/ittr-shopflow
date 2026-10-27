# ITTR ShopFlow v24.76.5: engineering audit

**Question:** looked at as a senior software engineer, what in the platform would fail, lose data or leave the shop exposed in production? The audit also asks what the owner needs during a security incident like the Railway variable exposure of 21 October 2026.

**Baseline:** `main` at `9edf61b` (v24.76.4, PR #88 merged).

**How it was tested:**
- **Servers:** local only. Production-mode servers (`NODE_ENV=production`) ran on PostgreSQL 16 test databases. The servers were started both directly and the way Railway starts them (`npm start`).
- **Shutdown:** stopping was reproduced with real signals sent to real processes. These included requests that were still running and live phone connections.
- **Code reviewed:**
  - secrets stored in the database
  - the backup
  - sign-in and sessions
  - payments and the Stripe webhook
  - database use
  - startup and shutdown
  - dependencies and CI
- **Production evidence:** the only production evidence is the owner's screenshot of Railway's Deployments panel. It shows deployment #85, v24.76.2, built with `node@20.20.2`, one replica. The live site and Railway's settings could not be reached from this environment and were not inspected.

## Findings and fixes

| # | Finding | Evidence | Fix | Test |
|---|---|---|---|---|
| E1 | **Production runs on Node.js 20, which is past its end of life (April 2026).** CI tests on Node 24. Nothing in the repository chose a version, so Railpack used its default. | The Railway screenshot shows `node@20.20.2`. `package.json` had no `engines`, and there was no `.nvmrc`. | `engines.node` is `24`, and `.nvmrc` is `24`. Railpack reads both. GO-LIVE §8 says to check that the build log shows `node@24`, and to set `RAILPACK_NODE_VERSION=24` if it does not. | Not testable here: it takes effect on Railway's next build. |
| E2 | **On every deploy, requests still running were cut off and phones were not told to reconnect.** `npm start` (npm 10) does not pass SIGTERM on to Node, and the server had no shutdown handling, so the process was killed hard. Once the shutdown handling was added, it ran only when Node itself was started. | O4 on `main`: after SIGTERM to `npm start`, no shutdown line appears and the server keeps running (the run left an orphan server process, killed by hand). O3 on `main`: the live connection closes with 1006 (abnormal), not 1012. | `"start": "exec node server.js"`, so Node receives the signal. On SIGTERM or SIGINT the server stops accepting connections and lets running requests finish (up to `ITTR_SHUTDOWN_GRACE_MS`, default 10 s). Answers sent while stopping carry `Connection: close`. Live phones get close code 1012 ("service restart") and reconnect to the new server. The database pool is then closed and the process exits 0. | O3, O4 (new) |
| E3 | **The owner could not sign everyone out.** After an exposure, the database may have been read, and the only option was "sign out my other sessions". Remembered devices (30-day 2-step skip) stayed trusted. | Route inventory: only `/api/auth/sessions/revoke-others`, scoped to the caller. | **🔒 Password → Sign out everyone** (owner only). It ends every sign-in except this one, forgets every remembered device, drops the live connections of those sessions at once, and records it in the activity log. Customer links (estimates, inspections, the fleet portal) are not affected; their tokens are stored as hashes, and each can be revoked on its own as before. | O1 (new) |
| E4 | **Nothing told the owner when their password was still the setup password saved in Railway** (`BOOTSTRAP_ADMIN_PASSWORD`). That value was among the exposed variables. If the owner never changed it, the exposed value *is* the owner's password. | The bootstrap code creates the owner from that variable. Nothing compared later sign-ins with it. | Sign-in compares the password with the variable (constant time, hashes of equal length). While they match, the app shows a warning and a notice at the top of 🔒 Password. The sign-in is flagged in the activity log. The warning stops once the password is changed. | O2 (new) |
| E5 | **The owner had no way to review sign-ins.** Sign-ins were logged, but with no address or device, and no screen showed them. | `server_audit` rows for `login` held only the username. | Each sign-in records its address (as seen through Railway's proxy) and browser. **🔒 Password → Recent sign-ins** (owner only) lists the last 200 sign-in and account-security events. These are sign-ins, lockouts, password changes, 2-step changes and sign-outs. Sign-ins with the setup password are highlighted. | O2 |
| E6 | **My earlier rotation guidance for Twilio was wrong.** I said the Twilio settings were kept in the database. They are Railway variables (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`), so they were among the exposed values. | `server.js` reads them from the environment (the `env.X` pattern my first search missed). | GO-LIVE §9 now covers this. Make a secondary auth token in Twilio and put it in Railway. After the deploy, promote it to primary so the old token stops working. | Docs |

Each new scenario (O1–O4) fails when run against `main` and passes here.

GO-LIVE §9 now starts with the steps that need no deploy:
1. change the owner's password;
2. turn on 2-step login;
3. after the database password is rotated, press **Sign out everyone**;
4. review accounts and recent sign-ins.

## Checked and found sound

- **Secrets in the database:** the following are stored as hashes:
  - session tokens
  - customer link tokens
  - remembered-device tokens
  - email codes
  - 2-step recovery codes
  - passwords (bcrypt, cost 12)

  Gmail tokens are encrypted with `GMAIL_TOKEN_KEY`. Someone who reads the database cannot take over a session or a customer link with what they find.
- **Backup:** the download strips password hashes, 2-step secrets and Gmail tokens.
- **Bootstrap owner:** it is created only when no active owner exists, so the exposed `BOOTSTRAP_ADMIN_PASSWORD` cannot create a second owner on a running shop.
- **Stripe:** the webhook checks Stripe's signature and locks the invoice row. It records a payment only once per payment reference, so a replayed event records nothing twice. Manual payments and invoice finalizing run in database transactions with the invoice row locked.
- **Database failures:** the pool has an error listener (`server.js:139`). A server whose database connections were terminated (`pg_terminate_backend`) stayed up and recovered. The readiness check gives up after 5 s instead of hanging.
- **Event loop:** request handlers use almost no synchronous file or CPU-heavy work.
- **Sign-in limits:**
  - 100 signed-out calls per 15 minutes per address;
  - 10 failed sign-ins per 15 minutes per address;
  - an account locks for 15 minutes after 8 wrong passwords or codes in a row;
  - the server trusts exactly one proxy hop (Railway's).
- **Dependencies:** `npm audit` reports 0 known vulnerabilities.

## Corrections to my own earlier statements

- **Twilio (E6):** corrected in GO-LIVE §9.
- **Pool error listener:** in a first pass I reported that the database pool had no error listener, so a dropped connection would crash the server. That was wrong: my search missed `pool?.on("error", …)`. A reproduction showed the server survives terminated connections. It is not a defect and nothing was changed.

## Recommended, not changed

**Hosting setting (needs the owner's decision):**
- **Draining time:** Railway gives the old server 0–3 s after SIGTERM by default. E2 makes the server use that time well. Setting **Railway → web → Settings → Deploy → Draining seconds** to 15 (or `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`) would let longer requests finish too, such as PDF builds and AI answers. This is a hosting setting and I did not change it.

**Security:**
- **2-step secret:** the authenticator-app secret (`totp_secret`) is stored in plain text. Someone who reads the database could generate codes, though they would still need the password. Encrypting it like the Gmail tokens needs a migration and a key in Railway.
- **Failed sign-ins:** a single wrong password is not logged, only the lockout after 8 in a row. Logging each one would help spot password guessing, but it adds a row per wrong password.

**Reliability:**
- **Database timeouts:** the pool sets no `connectionTimeoutMillis` and no `statement_timeout`. A stuck query or an unreachable database holds the request until the proxy gives up. Values of about 10 s to connect and 30 s per statement would match the app's work, but they should be tried against the Fullbay import and backups first.

**Dependencies:** all are pinned to exact versions, with 0 known vulnerabilities. Three are a major version behind and need a planned upgrade with testing:

| Package | Installed | Latest |
|---|---|---|
| `openai` | 5.0 | 7.45 |
| `pdfkit` | 0.17 | 0.20 (invoice PDFs) |
| `dotenv` | 16 | 18 |

A scheduled dependency check (for example Dependabot, which GitHub includes) would surface security updates.

**Code health:**
- `frontend_check_2471.js` and `frontend_check_2481.js` (about 330 KB each) are referenced only by old audit reports.
- The architecture items from the v24.76.4 report still stand:
  - the whole-shop document is read and written whole;
  - `server.js` and `index.html` are very large;
  - inline handlers keep CSP on `'unsafe-inline'`;
  - the invoice CSS is layered with `!important`;
  - the mirrored copies are kept in sync by hand.

**Windows:** the `exec` in `npm start` needs a POSIX shell, as on Railway, macOS and Linux. On Windows, start the server with `node server.js`.

## Full check

The full `npm run check` uses PostgreSQL 16 and Chromium, with `ITTR_REQUIRE_DB_SUITES=1 ITTR_REQUIRE_BROWSER_SUITE=1`. It now includes the new **operations safety** suite (O1–O4).

**Result:** exit 0. All 25 required suites passed, none skipped:
- operations safety O1–O4
- the audit suite
- control sweep: 882 pointer clicks on 56 role/page combinations, none covered; 137 controls skipped because they delete data or contact someone outside the shop
- smoke test, v24.76.5

Also checked: `node production_audit.mjs` (215/215), the inline-handler guard, the language audit, the syntax of every script, and that the root/public mirrors are identical.

The local tests ran on Node 22.22.2 with npm 10.9.7. CI (`release-check`) runs on Node 24. The suite was not run on Node 20.

## Not tested

- the live Railway service, its settings, its draining time and its build log
- whether the next Railway build actually picks Node 24
- real phones reconnecting after a deploy
- real Twilio, Stripe, Gmail, R2 and Samsara accounts
- load, and a restore from backup

This audit does not show that the platform is fully secure.

## Deploy / rollback

There is no migration and no required new setting. `ITTR_SHUTDOWN_GRACE_MS` is optional.

After the deploy:
- the build log should say `node@24`;
- `/api/health` reports 24.76.5;
- devices pick up the `ittr-shopflow-v24.76.5` cache.

To roll back, redeploy v24.76.4. Its `npm start` and Node version are the old ones.
