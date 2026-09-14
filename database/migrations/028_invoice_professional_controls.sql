-- ITTR v24.6.5 professional invoice controls (non-destructive)
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS default_labor_rate NUMERIC DEFAULT 0;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN DEFAULT FALSE;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS tax_exempt_number TEXT;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS tax_exempt_reason TEXT;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS tax_rate_source TEXT;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS tax_location_city TEXT;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS tax_location_county TEXT;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS reopened_by TEXT;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS reopen_reason TEXT;
