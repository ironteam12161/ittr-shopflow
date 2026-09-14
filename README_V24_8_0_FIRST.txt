ITTR v24.8.0 — AI + MANAGER RBAC + CUSTOMER PAYMENTS/EMAIL FOUNDATION

DEPLOYMENT
1. Deploy over the SAME Railway project and SAME PostgreSQL database.
2. Do NOT reset PostgreSQL and do NOT re-import Fullbay.
3. Existing OPENROUTER_API_KEY continues to power ITTR AI.
4. Optional customer payment links: add STRIPE_SECRET_KEY and confirm APP_PUBLIC_URL.
5. Optional invoice email: add RESEND_API_KEY and INVOICE_FROM_EMAIL (verified sender).
6. Never place these keys in index.html or send them in chat.
7. Verify /api/build shows frontend/backend 24.8.0.

NEW
- Floating ITTR AI Shop Assistant for managers and mechanics.
- Multilingual unit-history questions grounded in customer_units, Fullbay service history, and ITTR invoice labor history.
- Example: "коли була заміна масла на 6600?"
- Manager account role and permission profile foundation.
- Owner/admin-only permanent invoice deletion with typed invoice-number confirmation and audit event.
- Stripe Checkout payment-link creation (server-side key only).
- Resend invoice email action with payment button when a payment link exists.
- Existing v24.7.1 major system audit and job-level vehicle history preserved.

IMPORTANT PAYMENT NOTE
The package creates Stripe-hosted checkout links. Automatic payment reconciliation/webhook posting is intentionally not enabled without a configured and verified webhook secret. Until that is configured, use the existing Record Payment workflow after confirming settlement. Do not mark invoices paid from an unverified browser redirect.
