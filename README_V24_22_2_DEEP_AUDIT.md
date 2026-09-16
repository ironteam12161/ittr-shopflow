# v24.22.4 Deep Audit Fix
Production duplicate scan failed because v24.22.0/1 queried `fullbay_import_customers.usdot`, but the real schema column is `dot_number`.
This release fixes that exact mismatch, audits the new Samsara/duplicate-customer code against the real DB schema, relinks invoices and service orders during customer merge, and adds a non-destructive merge preview with typed MERGE + confirmation.
No database reset. No schema migration.
