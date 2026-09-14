ITTR ShopFlow v24.13.0 — Service-Card Invoicing

Deploy over the existing GitHub/Railway project and existing PostgreSQL database. DO NOT reset the database.

Invoice workflow:
- Create a Service / Repair Job.
- Add parts directly inside that service.
- Add labor below those parts.
- Labor rates restored: New client $115, Our client $110, Old client $100, Owner $60, Custom.
- Customer default_labor_rate is honored when available.

Run before deploy:
  npm run audit
