-- ITTR v23.9.0 - FMCSA / SAFER customer auto-fill metadata
ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_dba_name TEXT;
ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_mc_number TEXT;
ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_allowed_to_operate TEXT;
ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_out_of_service TEXT;
ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_power_units INTEGER;
ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_drivers INTEGER;
ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_snapshot JSONB;
ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_last_checked TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_fullbay_customers_fmcsa_mc ON fullbay_import_customers(fmcsa_mc_number);
