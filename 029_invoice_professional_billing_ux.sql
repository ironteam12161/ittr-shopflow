ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS dot_number TEXT;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS discount_type TEXT DEFAULT 'fixed';
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS discount_value NUMERIC DEFAULT 0;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS billing_address TEXT;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS billing_city TEXT;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS billing_state TEXT;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS billing_postal_code TEXT;
UPDATE customer_invoices
SET discount_type='fixed',discount_value=coalesce(discount,0)
WHERE discount_value IS NULL OR (discount_value=0 AND coalesce(discount,0)<>0);
