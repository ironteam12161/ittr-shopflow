-- ITTR v21 Online Beta schema. server.js auto-creates these tables as well.
CREATE TABLE IF NOT EXISTS auth_users (
 id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','mechanic')),
 language TEXT DEFAULT 'en', active BOOLEAN DEFAULT TRUE,
 created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_sessions (
 id BIGSERIAL PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
 user_id BIGINT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_state (
 state_key TEXT PRIMARY KEY, payload JSONB NOT NULL DEFAULT '{}'::jsonb,
 version BIGINT NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ DEFAULT now(), updated_by TEXT
);
CREATE TABLE IF NOT EXISTS server_audit (
 id BIGSERIAL PRIMARY KEY, username TEXT, action TEXT NOT NULL, details JSONB,
 created_at TIMESTAMPTZ DEFAULT now()
);


-- ITTR v22 data safety + pause/resume + finding decision history
CREATE TABLE IF NOT EXISTS schema_migrations(
  migration_key TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_state_history(
  id BIGSERIAL PRIMARY KEY,
  state_key TEXT NOT NULL,
  version BIGINT NOT NULL,
  payload JSONB NOT NULL,
  updated_by TEXT,
  captured_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_state_history_key_time
  ON app_state_history(state_key,captured_at DESC);
CREATE TABLE IF NOT EXISTS task_time_sessions(
  id BIGSERIAL PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  task_index INTEGER NOT NULL,
  task_uid TEXT,
  task_name TEXT,
  mechanic_username TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  pause_reason TEXT,
  pause_note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_sessions_workorder
  ON task_time_sessions(work_order_id,task_index,started_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_sessions_mechanic
  ON task_time_sessions(mechanic_username,started_at DESC);
CREATE TABLE IF NOT EXISTS data_exports(
  id BIGSERIAL PRIMARY KEY,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  note TEXT
);
INSERT INTO schema_migrations(migration_key)
VALUES('022_data_safe_pause_resume_findings')
ON CONFLICT(migration_key) DO NOTHING;


-- ITTR v23.1: private R2-backed finding photo metadata
CREATE TABLE IF NOT EXISTS finding_photos(
  id TEXT PRIMARY KEY, finding_id TEXT NOT NULL, work_order_id TEXT NOT NULL, uploader_username TEXT NOT NULL,
  r2_key TEXT UNIQUE NOT NULL, content_type TEXT NOT NULL DEFAULT 'image/jpeg', size_bytes BIGINT NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, original_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_finding_photos_finding ON finding_photos(finding_id,created_at);
CREATE INDEX IF NOT EXISTS idx_finding_photos_workorder ON finding_photos(work_order_id,created_at);
CREATE INDEX IF NOT EXISTS idx_finding_photos_uploader ON finding_photos(uploader_username,created_at);


-- v23.8 Customer CRM / Fullbay data directory
CREATE TABLE IF NOT EXISTS fullbay_import_customers(
  id BIGSERIAL PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, fullbay_id TEXT, customer_name TEXT NOT NULL,
  phone TEXT, email TEXT, address TEXT, city TEXT, state TEXT, postal_code TEXT, raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_file TEXT, imported_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), active BOOLEAN, created_fullbay TIMESTAMPTZ,
  customer_group TEXT, secondary_phone TEXT, dot_number TEXT, external_id TEXT, country TEXT, assigned_shop TEXT, taxable BOOLEAN,
  tax_exempt_number TEXT, credit_terms TEXT, credit_limit NUMERIC, billing_contact TEXT, payment_method TEXT, default_labor_rate NUMERIC,
  price_level TEXT, access_method TEXT, billing_address TEXT, billing_city TEXT, billing_state TEXT, billing_postal_code TEXT, ext_accounting TEXT,
  notes TEXT, contact_name TEXT, fmcsa_dba_name TEXT, fmcsa_mc_number TEXT, fmcsa_allowed_to_operate TEXT, fmcsa_out_of_service TEXT, fmcsa_power_units INTEGER, fmcsa_drivers INTEGER, fmcsa_snapshot JSONB, fmcsa_last_checked TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS fullbay_import_parts(
  id BIGSERIAL PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, fullbay_id TEXT, part_number TEXT, description TEXT, quantity NUMERIC, cost NUMERIC, price NUMERIC, location TEXT, vendor TEXT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb, source_file TEXT, imported_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), status TEXT, uom TEXT, allocated NUMERIC, min_qty NUMERIC, max_qty NUMERIC,
  track_quantity BOOLEAN, category TEXT, cost_floor NUMERIC, inventory_value NUMERIC, inventory_balance NUMERIC, manufacturer TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS fullbay_import_log(
  id BIGSERIAL PRIMARY KEY, import_type TEXT NOT NULL, source_file TEXT, rows_received INTEGER DEFAULT 0, rows_imported INTEGER DEFAULT 0, rows_skipped INTEGER DEFAULT 0, username TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_units(
  id BIGSERIAL PRIMARY KEY, customer_id BIGINT REFERENCES fullbay_import_customers(id) ON DELETE SET NULL, customer_name TEXT, unit_number TEXT, vin TEXT, year TEXT, make TEXT, model TEXT, plate TEXT, mileage BIGINT, engine TEXT, transmission TEXT, notes TEXT, source TEXT DEFAULT 'manual', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fullbay_customers_name ON fullbay_import_customers(lower(customer_name));
CREATE INDEX IF NOT EXISTS idx_fullbay_customers_dot ON fullbay_import_customers(dot_number);
CREATE INDEX IF NOT EXISTS idx_fullbay_parts_number ON fullbay_import_parts(lower(part_number));
CREATE INDEX IF NOT EXISTS idx_fullbay_parts_description ON fullbay_import_parts(lower(description));
CREATE INDEX IF NOT EXISTS idx_fullbay_parts_manufacturer ON fullbay_import_parts(lower(manufacturer));
CREATE INDEX IF NOT EXISTS idx_customer_units_unit ON customer_units(lower(unit_number));
CREATE INDEX IF NOT EXISTS idx_customer_units_customer ON customer_units(customer_id);

-- v24.1 Fullbay Details / service-history import
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS unit_status TEXT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS unit_type TEXT;
ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS unit_subtype TEXT;
CREATE TABLE IF NOT EXISTS fullbay_service_history(
  id BIGSERIAL PRIMARY KEY,
  source_key TEXT UNIQUE NOT NULL,
  customer_id BIGINT REFERENCES fullbay_import_customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  unit_record_id BIGINT REFERENCES customer_units(id) ON DELETE SET NULL,
  unit_number TEXT, vin TEXT, unit_status TEXT, unit_type TEXT, unit_subtype TEXT,
  service_order TEXT, invoice_number TEXT, po_number TEXT, action_number TEXT,
  action_completed_at TIMESTAMPTZ, lead_tech TEXT, tech TEXT,
  complaint TEXT, actual_correction TEXT, hours NUMERIC, labor_amount NUMERIC, part_amount NUMERIC, total_amount NUMERIC,
  unit_miles BIGINT, component TEXT, system TEXT, raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_file TEXT, imported_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fullbay_service_customer ON fullbay_service_history(customer_id,action_completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fullbay_service_unit ON fullbay_service_history(lower(unit_number),action_completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fullbay_service_vin ON fullbay_service_history(lower(vin));
CREATE INDEX IF NOT EXISTS idx_fullbay_service_so ON fullbay_service_history(service_order);


-- v24.5.1 Parts, vendor receiving, manufacturer barcodes, and physical inventory count
ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS internal_barcode TEXT;
ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS barcode_aliases JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS reorder_point NUMERIC;
ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS on_order NUMERIC DEFAULT 0;
ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS inventory_managed BOOLEAN DEFAULT TRUE;
ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS purchase_taxable BOOLEAN DEFAULT TRUE;
ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS sell_taxable BOOLEAN DEFAULT TRUE;
ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS purchase_tax_rate NUMERIC DEFAULT 0;
ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS last_purchase_cost NUMERIC;
ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS previous_purchase_cost NUMERIC;
ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS last_purchase_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fullbay_parts_internal_barcode ON fullbay_import_parts(internal_barcode) WHERE internal_barcode IS NOT NULL;
CREATE TABLE IF NOT EXISTS parts_vendors(
 id BIGSERIAL PRIMARY KEY, canonical_name TEXT UNIQUE NOT NULL, aliases JSONB NOT NULL DEFAULT '[]'::jsonb, website_domain TEXT, phone TEXT, notes TEXT, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS part_inventory_transactions(
 id BIGSERIAL PRIMARY KEY, part_id BIGINT NOT NULL REFERENCES fullbay_import_parts(id) ON DELETE RESTRICT, transaction_type TEXT NOT NULL, quantity_delta NUMERIC NOT NULL, quantity_before NUMERIC, quantity_after NUMERIC, work_order_id TEXT, task_uid TEXT, task_name TEXT, unit_number TEXT, customer_name TEXT, reference TEXT, reason TEXT, username TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS parts_vendor_invoices(
 id BIGSERIAL PRIMARY KEY, vendor TEXT, invoice_number TEXT, invoice_date DATE, po_number TEXT, subtotal NUMERIC, tax NUMERIC, freight NUMERIC, total NUMERIC, tax_rate NUMERIC DEFAULT 0, tax_included_in_cost BOOLEAN DEFAULT FALSE, source_filename TEXT, source_method TEXT DEFAULT 'scan', status TEXT DEFAULT 'draft', raw_extract JSONB NOT NULL DEFAULT '{}'::jsonb, created_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), received_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_parts_vendor_invoice_unique ON parts_vendor_invoices(lower(coalesce(vendor,'')),lower(coalesce(invoice_number,''))) WHERE invoice_number IS NOT NULL;
CREATE TABLE IF NOT EXISTS parts_vendor_invoice_lines(
 id BIGSERIAL PRIMARY KEY, invoice_id BIGINT NOT NULL REFERENCES parts_vendor_invoices(id) ON DELETE CASCADE, line_no INTEGER, vendor_part_number TEXT, manufacturer TEXT, description TEXT, quantity NUMERIC, unit_cost NUMERIC, core_cost NUMERIC DEFAULT 0, line_total NUMERIC, taxable BOOLEAN DEFAULT TRUE, tax_amount NUMERIC DEFAULT 0, matched_part_id BIGINT REFERENCES fullbay_import_parts(id) ON DELETE SET NULL, match_status TEXT DEFAULT 'unmatched', received_quantity NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS part_purchase_cost_history(
 id BIGSERIAL PRIMARY KEY, part_id BIGINT NOT NULL REFERENCES fullbay_import_parts(id) ON DELETE RESTRICT, vendor TEXT, invoice_number TEXT, invoice_id BIGINT REFERENCES parts_vendor_invoices(id) ON DELETE SET NULL, purchased_at TIMESTAMPTZ DEFAULT now(), quantity NUMERIC NOT NULL, unit_cost NUMERIC NOT NULL, core_cost NUMERIC DEFAULT 0, username TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory_count_sessions(
 id BIGSERIAL PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open', mode TEXT NOT NULL DEFAULT 'shelf', notes TEXT, started_by TEXT NOT NULL, started_at TIMESTAMPTZ DEFAULT now(), completed_by TEXT, completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS inventory_count_lines(
 id BIGSERIAL PRIMARY KEY, session_id BIGINT NOT NULL REFERENCES inventory_count_sessions(id) ON DELETE CASCADE, part_id BIGINT NOT NULL REFERENCES fullbay_import_parts(id) ON DELETE RESTRICT, system_qty NUMERIC NOT NULL DEFAULT 0, counted_qty NUMERIC NOT NULL DEFAULT 0, last_barcode TEXT, counted_by TEXT, first_counted_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(session_id,part_id)
);
