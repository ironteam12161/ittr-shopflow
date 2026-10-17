# ITTR ShopFlow v24.74.0: fixes for the October 17, 2026 portal, email and Operations audit

**Baseline:** v24.73.0, commit `0a3adf9`.

Each finding was reproduced against the baseline with the new `portal_email_integration_test.mjs`. That test uses a real server, a throw-away database, and fake Google/Resend servers on 127.0.0.1.

- On the baseline, **all 11 scenarios fail**.
- Now, **all 11 pass**.
- No real email was sent and no payment was created. Production was not contacted.

| ID | Finding | Status | What changed |
|---|---|---|---|
| P1 | Portal totals used only the latest 150 invoices | Fixed | The "You owe" and Overdue figures are now a sum over all of the customer's invoices. Every unpaid invoice is listed ahead of recent history. Older invoices with no customer link are matched by name only when exactly one customer has that name. |
| E1 | Gmail accepted, then bookkeeping failed, then Resend sent a duplicate | Fixed | Once Gmail accepts a message it is final, and the Resend backup is used only for mail Google did not accept. If the invoice or estimate send-record fails after acceptance, the answer is "sent" with a warning. The delivery is no longer marked failed. |
| P2 | Partial inspection approval returned a bare error | Fixed | Each repair is decided on its own. The answer lists each repair's outcome, and the customer page shows which repairs were and were not recorded. An error is returned only when none were recorded. |
| P5 | Choosing Approve/Decline erased the signature draft | Fixed | The name, note, tick box and keyboard focus are kept when the page redraws. |
| E2 | "Email link" accepted any host | Fixed | The URL is built from the shop's own address. A link with another host is refused. |
| P4 | Stripe returned customers to the staff login | Fixed | Customers now return to the public `/pay/return` page. It shows "paid", "being confirmed" or "not completed" as recorded by the server. The page is keyed by a random reference created with each checkout, and it shows no account details. |
| O1 | AI CSV shortcut opened an unknown page | Fixed | It now opens Operations → Fullbay. |
| E3 | Email said a PDF was attached when it was not | Fixed | The "attached" line and the default "is attached" wording are left out when no PDF is attached. |
| Revocation | Estimate links opened from a portal outlived the portal | Fixed (policy) | Turning a portal off, or the portal expiring, also ends the estimate links opened from it. Links emailed separately are not affected, and the Turn off prompt says so. |

**Migration:** adds the column `customer_invoices.payment_return_ref`. This runs automatically and is additive.

**Rollback:** redeploy v24.73.0. Payment links created on v24.74.0 would then return to `/pay/return`, which v24.73.0 does not serve, so customers would see the staff app again.

## Not done in this release (design work)

- **Durable delivery outbox.** A send ledger with an explicit "uncertain" state and provider delivery/bounce webhooks.
- **Operations restructure.** Daily shop, Team, Maintenance, Integrations, Data quality and Owner recovery areas.
- **One source for maintenance plans.** Operations and Compliance still keep separate maintenance data.
- **Not checked.** SPF/DKIM/DMARC for the sender domain, and how the email renders in Gmail and Outlook, need owner access.
