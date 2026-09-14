ALTER TABLE customer_invoice_lines ADD COLUMN IF NOT EXISTS discount_type TEXT DEFAULT 'fixed';
ALTER TABLE customer_invoice_lines ADD COLUMN IF NOT EXISTS discount_value NUMERIC DEFAULT 0;
UPDATE customer_invoice_lines SET discount_type='fixed', discount_value=coalesce(discount,0) WHERE discount_value IS NULL OR (discount_value=0 AND coalesce(discount,0)<>0);
INSERT INTO schema_migrations(migration_key) VALUES('028_invoice_line_discount_controls') ON CONFLICT(migration_key) DO NOTHING;
