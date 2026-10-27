# Starting the shop on ITTR ShopFlow: go-live checklist

Work through this list in order. Steps marked **required** are needed before the first real customer. Everything else turns on a feature and can be done later. The settings are listed in `.env.example`.

## 1. Hosting (Railway), required

1. **Service:** deploy the `main` branch from GitHub. `railway.json` already sets the start command (`npm start`) and the health check (`/api/health`).
2. **Database:** add a Railway PostgreSQL service, and turn on its **automatic backups** before any real data goes in.
3. **Variables:**

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | Reference the Postgres service (`${{Postgres.DATABASE_URL}}`). The private `*.railway.internal` address needs no SSL. |
   | `BOOTSTRAP_ADMIN_USERNAME` | The owner's sign-in name |
   | `BOOTSTRAP_ADMIN_PASSWORD` | At least 10 characters. It is used once, to create the owner on an empty database. |
   | `APP_PUBLIC_URL` | The public address, e.g. `https://shop.ironttr.com`. Customer links and emails point here. |
   | `SHOP_TIMEZONE` | `America/Chicago` unless the shop is elsewhere |
   | `SHOP_*` | Name, address, phone and email printed on invoices |

4. **Domain:** add the custom domain in Railway and wait for its HTTPS certificate.
5. **Check the deploy:**
   - `https://<your address>/api/health` shows `"ready":true` and `"version":"24.76.5"`.
   - `/api/build` shows the deployed commit.
   - If `BOOTSTRAP_ADMIN_PASSWORD` was missing or too short, the deploy log says `ITTR SETUP REQUIRED` and nobody can sign in. Set it and redeploy.

## 2. Owner's first sign-in, required

1. Sign in with the bootstrap name and password.
2. **🔒 Password:** change the password, then **turn on 2-step login** and keep the recovery codes somewhere safe. After that, `BOOTSTRAP_ADMIN_PASSWORD` can be removed from Railway; it is never used again once an owner exists.
3. **🔒 Password → Download backup:** check that a backup downloads. It is one JSON file and ends with `"complete": true`.
4. If you tried things out with test data first: **Operations → Start fresh (owner)** erases it. Use it before real work begins, not after.

## 3. People, required

1. **Team → + Add Mechanic** for each mechanic. Each one gets their own sign-in.
2. **Team → + Add Manager** for office staff. A manager sees only the areas ticked: Invoices, Money/Financials, Parts/Inventory, Customers, Reports, Employees. Tick only what each person needs. A manager without Customers cannot see texts or customer phone numbers.
3. **Time clock:** decide whether mechanics must clock in before they can start a job ("Require clock-in before work"). Today it requires clock-in.

## 4. Phones and shop computers

1. On each mechanic's phone, open the site in Safari or Chrome. Choose **Add to Home Screen**, then sign in. The app works offline and catches up when the signal returns.
2. Each person can set their language (English or Ukrainian) on their account.
3. **A walk-through for mechanics:**
   - **Clock In** at the start of the shift.
   - A truck the office scheduled shows under **Upcoming / On the Way**. When it arrives, tap **✓ Truck Is Here**. It moves to **Ready to Work**.
   - Tap **Open Job**, then **Start Task**. Finish with **Complete Task**, and **Complete Work Order** with a short note.
   - A walk-in can be started on the phone with **＋ Start New Job**.

## 5. Customers, parts and history

- **Start empty:** add customers as they come in (**Customers & Vehicles → + Add Customer**), or
- **Bring data over:** use **Operations → Fullbay & Samsara** for imports and unit sync. Run the import audit first; nothing merges automatically. Never put customer export files (CSV) in the GitHub repository.
- **Parts:** set buy and sell prices so invoices do not show $0 parts. Fluids can be counted in gallons (**Parts → 🛢 Fluids**).

## 6. Optional features (each needs its settings in Railway)

| Feature | Settings | Before using it with customers |
|---|---|---|
| Invoice email (Resend) | `RESEND_API_KEY`, `INVOICE_FROM_EMAIL`, `INVOICE_REPLY_TO` | Verify the domain in Resend. Send one invoice to a shop mailbox first. |
| Email as the shop + Zelle/vendor-bill inbox (Gmail) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_TOKEN_KEY` | Connect in the app; send a test email to the shop |
| Pay online by card (Stripe) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Add the webhook `<APP_PUBLIC_URL>/api/stripe/webhook`. Make one small real payment and check that the invoice shows it paid. |
| Texting customers (Twilio) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Set the number's webhook to `<APP_PUBLIC_URL>/api/sms/inbound`. US numbers need A2P 10DLC registration. |
| Finding photos (Cloudflare R2) | `R2_BUCKET_NAME`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Keep the bucket private. Without R2, photos cannot be uploaded. |
| Fleet mileage (Samsara) | `SAMSARA_API_TOKEN` | **Operations → Samsara → Check Connection** |
| Carrier lookup by USDOT | `FMCSA_WEBKEY` | Try one USDOT number in the customer form |
| AI help | `OPENROUTER_API_KEY` (free models) or `OPENAI_API_KEY` | Set a monthly budget in **Operations → AI usage & budget** |
| Error alerts | `ALERT_WEBHOOK_URL` (Slack/Discord/Teams) | — |

## 7. Practice run, then go live

Do one full job with a made-up customer, on real devices:

1. Work order in the office.
2. The mechanic clocks in, taps Truck Is Here, starts and completes the job, and completes the work order on the phone.
3. The office makes the invoice, prices it, finalizes it, records a payment and opens the PDF.
4. The sale shows in Reports.

Then remove the practice data (**Start fresh**, or void the invoice), and go live.

## 8. After go-live

- **Monitoring:** add an uptime monitor (e.g. UptimeRobot, free) on `<APP_PUBLIC_URL>/api/health`.
- **Branch protection:** in GitHub, require the **audit** check on `main`, and deploy only from `main` after it passes.
- **Backups:** download a backup weekly (**🔒 Password → Download backup**) in addition to Railway's. Once, restore a Railway backup into a separate test database to prove recovery works. Photos in R2 are not in the database backup.
- **One server:** keep one Railway replica. Live updates between devices assume a single server process.
- **Deploys without cut-off requests (optional):** on each deploy Railway sends the old server SIGTERM and stops it soon after (0–3 s by default, per Railway's forum). Since v24.76.5 the server uses that time to finish running requests and tell phones to reconnect. To give it more time, set **Railway → web → Settings → Deploy → Draining seconds** (or the `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` variable) to `15`.
- **Node.js version:** the app is built and tested on Node 24 (`engines.node` and `.nvmrc`). After a deploy, the build log should say `node@24`. If it still shows 20, set the Railway variable `RAILPACK_NODE_VERSION=24`.
- **Check the deployed version:** `<APP_PUBLIC_URL>/api/health` shows `"version"`. If it is older than `main`, Railway did not build the latest commit. Open **web → Deployments** and deploy the latest commit. **Redeploy** on an old entry rebuilds that same old commit.

## 9. If the host's secrets are exposed (key rotation)

Railway keeps every setting the server reads. If Railway (or any host) reports that environment variables were exposed, treat every value as known to someone else.

**First, in the app (takes effect at once, no deploy needed):**
1. **Change the owner's password** (**🔒 Password**). The owner account was created from `BOOTSTRAP_ADMIN_PASSWORD`; if it was never changed, that exposed setting *is* the owner's password. Since v24.76.5 the app warns at sign-in when the setup password is still in use.
2. **Turn on 2-step login** for the owner and every manager, in the same window.
3. Railway's database can usually be reached from the internet with its own password, so assume the database was readable too. After the database password is rotated (below), press **🔒 Password → Sign out everyone**: every sign-in on every device ends and remembered devices ask for a code again.
4. Look through **Accounts** for people you did not add, and through **🔒 Password → Recent sign-ins** (who signed in, when, from which address and device) for sign-ins you do not recognise.

**Then rotate each setting** at its provider, put the new value in **Railway → web → Variables**, deploy once, then revoke the old one:

| Setting | Where to make a new one | After the deploy |
|---|---|---|
| `DATABASE_URL` | Railway → **Postgres** → regenerate the password. Keep the app's `DATABASE_URL` as `${{Postgres.DATABASE_URL}}`. | The app stops reaching the database until it is redeployed, so do this last, right before the deploy. |
| `STRIPE_SECRET_KEY` | Stripe → **Developers → API keys** → roll the secret key, with the shortest expiry that covers the deploy. | Check **Payments** and **Payouts** for anything you did not make. |
| `STRIPE_WEBHOOK_SECRET` | Stripe → **Developers → Webhooks** → your endpoint → roll the signing secret. | — |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Cloudflare → **R2 → Manage R2 API tokens** → new token, Object Read & Write on the photo bucket. | Delete the old token. |
| `GOOGLE_CLIENT_SECRET` | Google Cloud → **APIs & Services → Credentials** → the OAuth client → add a secret. | Delete the old secret. |
| `GMAIL_TOKEN_KEY` | Any new random value of 32 or more characters. | The saved Gmail connection can no longer be read: **Email settings → Disconnect**, then connect Gmail again (this also replaces its refresh token). |
| `OPENROUTER_API_KEY`, `OPENAI_API_KEY` | openrouter.ai → **Keys**; platform.openai.com → **API keys**. | Delete the old keys. Until then the AI features answer "AI provider rejected the API key"; the rest of the app works. |
| `RESEND_API_KEY`, `SAMSARA_API_TOKEN`, `FMCSA_WEBKEY`, `ALERT_WEBHOOK_URL` | Each provider's API keys page (for the alert webhook, make a new webhook). | Delete the old keys. |
| `BOOTSTRAP_ADMIN_PASSWORD` | Change the owner's password in the app (**🔒 Password**) and turn on 2-step login. | Delete this setting or set it to the new password; it is only used on an empty database. |
| `TWILIO_AUTH_TOKEN` (and check `TWILIO_ACCOUNT_SID`, `TWILIO_FROM`) | Twilio console → **Account → API keys & tokens** → create a secondary auth token, put it in Railway as `TWILIO_AUTH_TOKEN`. | After the deploy, promote the secondary token to primary in Twilio so the old one stops working. Incoming texts are checked against this token, so they are refused between promoting it and the deploy. |

Then check `<APP_PUBLIC_URL>/api/health` (`"ready":true` and the expected version), sign in, open an invoice, and send a test email.

## What has and has not been checked

On 21 October 2026, the app was started exactly as Railway does (`NODE_ENV=production`) on an empty database. The whole first day above was then done in a real browser: a desktop for the owner and office, and a touch phone for the mechanic. The full test suite, including the real-pointer control sweep, also passed against a production-mode server.

Not checked, and to be done by the shop:
- the live Railway deployment and its settings
- real phones
- real email, SMS, Stripe, R2 and Samsara accounts
- a backup restore

This checklist does not show that the system is fully secure.
