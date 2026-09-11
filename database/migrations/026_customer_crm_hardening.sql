-- ITTR v23.8.3 Customer CRM hardening
-- Non-destructive. Adds missing CRM columns/indexes only.
CREATE TABLE IF NOT EXISTS customer_units(
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT REFERENCES fullbay_import_customers(id) ON DELETE SET NULL,
  customer_name TEXT,
  unit_number TEXT,
  vin TEXT,
  year TEXT,
  make TEXT,
  model TEXT,
  plate TEXT,
  mileage BIGINT,
  engine TEXT,
  transmission TEXT,
  notes TEXT,
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS customer_id BIGINT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS unit_number TEXT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS vin TEXT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS year TEXT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS make TEXT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS plate TEXT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS mileage BIGINT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS engine TEXT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS transmission TEXT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_customer_units_unit ON customer_units(lower(unit_number));
CREATE INDEX IF NOT EXISTS idx_customer_units_customer ON customer_units(customer_id);
INSERT INTO schema_migrations(migration_key) VALUES('026_customer_crm_hardening') ON CONFLICT(migration_key) DO NOTHING;
