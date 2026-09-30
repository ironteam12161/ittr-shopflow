# QuickBooks Online integration: plan

The goal is for QuickBooks to stay in sync with ShopFlow the way Fullbay's integration does: every finalized invoice, payment and vendor bill appears in QuickBooks without double entry.

## What gets synced (ShopFlow → QuickBooks)

| ShopFlow | QuickBooks Online object | When |
|---|---|---|
| Customer | Customer (matched by name/email; QBO id stored on the customer) | First invoice for that customer |
| Finalized invoice | Invoice. Lines use Items: *Labor*, *Parts*, *Shop supplies*, *Tire user fee*, *Tire disposal fee*, *Sublet*. Sales tax uses the QBO tax code. | On Finalize, and re-sent on edit while unpaid |
| Payment (cash/check/card/Zelle/ACH) | ReceivePayment, linked to the invoice, with the deposit account chosen per method | When recorded, or applied from the Gmail Zelle inbox |
| Void invoice | Void in QBO | On void |
| Received vendor bill (Smart Receiving) | Bill for the vendor (matched/created), expense account *Parts / COGS* | When received |
| Tire user fee collected | Separate liability item, so it can be remitted to the state | With the invoice |

The sync is one-way (ShopFlow is the source) to avoid conflicts. Payments recorded directly in QBO can later be pulled back once a day to mark ShopFlow invoices paid.

## What's needed from you

1. An Intuit Developer account (free) and a **QuickBooks Online** app. Add its Client ID and Secret to Railway as `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET`, plus the redirect URL `https://<your-app>/api/quickbooks/oauth/callback`.
2. A QBO Plus/Advanced company with:
   - Items for Labor, Parts, Tire user fee and Tire disposal fee
   - An income account for each
   - Deposit accounts for each payment method

   Your accountant can map these once in a ShopFlow settings screen.
3. A one-time decision on the **starting date**. Only invoices from that date forward are sent, so nothing already entered by hand is duplicated.

## How it will work technically

- The OAuth 2.0 connect flow uses the same pattern as the Gmail connection: owner-only, single-use state, and an encrypted refresh token.
- A `qbo_sync_log` table records each object's QBO id, status and error, with **Retry** buttons.
- An outbox queue means a QuickBooks outage never blocks invoicing, and failed items retry automatically.
- A Reports → *QuickBooks sync* page shows what is synced, pending or failed.

Estimated effort once the Intuit app exists: about 2–3 working sessions, including testing against the QuickBooks sandbox company.
