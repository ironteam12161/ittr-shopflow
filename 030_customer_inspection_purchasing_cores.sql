-- ITTR v24.31: additive, production-safe customer deletion, inspection history,
-- vendor price history, branch-aware purchasing, and core-return tracking.

ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

CREATE TABLE IF NOT EXISTS customer_deletion_events(
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  customer_name TEXT NOT NULL,
  deletion_mode TEXT NOT NULL CHECK(deletion_mode IN ('soft','hard')),
  reason TEXT,
  reference_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  customer_snapshot JSONB NOT NULL,
  deleted_by TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_deletion_events_customer ON customer_deletion_events(customer_id,deleted_at DESC);

CREATE TABLE IF NOT EXISTS mechanic_inspections(
  id BIGSERIAL PRIMARY KEY,
  work_order_id TEXT NOT NULL UNIQUE,
  unit_id BIGINT REFERENCES customer_units(id) ON DELETE SET NULL,
  customer_id BIGINT REFERENCES fullbay_import_customers(id) ON DELETE SET NULL,
  unit_number_snapshot TEXT NOT NULL,
  vin_snapshot TEXT,
  customer_name_snapshot TEXT,
  inspection_type TEXT NOT NULL,
  inspection_subtype TEXT,
  status TEXT NOT NULL,
  mechanic_username TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  results JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mechanic_inspections_unit ON mechanic_inspections(unit_id,completed_at DESC,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mechanic_inspections_unit_snapshot ON mechanic_inspections(lower(unit_number_snapshot),completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_mechanic_inspections_vin_snapshot ON mechanic_inspections(lower(vin_snapshot));

ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS has_core BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS default_core_charge NUMERIC NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS parts_vendor_locations(
  id BIGSERIAL PRIMARY KEY,
  vendor_id BIGINT NOT NULL REFERENCES parts_vendors(id) ON DELETE RESTRICT,
  branch_name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  phone TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(vendor_id,branch_name)
);
CREATE INDEX IF NOT EXISTS idx_parts_vendor_locations_vendor ON parts_vendor_locations(vendor_id,active,branch_name);

ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS vendor_id BIGINT REFERENCES parts_vendors(id) ON DELETE SET NULL;
ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS vendor_location_id BIGINT REFERENCES parts_vendor_locations(id) ON DELETE SET NULL;
ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS vendor_branch_snapshot TEXT;
ALTER TABLE parts_vendor_invoice_lines ADD COLUMN IF NOT EXISTS has_core BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE part_purchase_cost_history ADD COLUMN IF NOT EXISTS vendor_id BIGINT REFERENCES parts_vendors(id) ON DELETE SET NULL;
ALTER TABLE part_purchase_cost_history ADD COLUMN IF NOT EXISTS vendor_location_id BIGINT REFERENCES parts_vendor_locations(id) ON DELETE SET NULL;
ALTER TABLE part_purchase_cost_history ADD COLUMN IF NOT EXISTS vendor_branch_snapshot TEXT;
ALTER TABLE part_purchase_cost_history ADD COLUMN IF NOT EXISTS landed_unit_cost NUMERIC;
CREATE INDEX IF NOT EXISTS idx_part_cost_history_vendor ON part_purchase_cost_history(part_id,vendor_id,vendor_location_id,purchased_at DESC);

CREATE TABLE IF NOT EXISTS part_core_obligations(
  id BIGSERIAL PRIMARY KEY,
  part_id BIGINT NOT NULL REFERENCES fullbay_import_parts(id) ON DELETE RESTRICT,
  purchase_history_id BIGINT REFERENCES part_purchase_cost_history(id) ON DELETE SET NULL,
  vendor_invoice_id BIGINT REFERENCES parts_vendor_invoices(id) ON DELETE SET NULL,
  vendor_invoice_line_id BIGINT REFERENCES parts_vendor_invoice_lines(id) ON DELETE SET NULL,
  vendor_id BIGINT NOT NULL REFERENCES parts_vendors(id) ON DELETE RESTRICT,
  vendor_location_id BIGINT REFERENCES parts_vendor_locations(id) ON DELETE SET NULL,
  vendor_name_snapshot TEXT NOT NULL,
  vendor_branch_snapshot TEXT,
  quantity NUMERIC NOT NULL CHECK(quantity>0),
  unit_core_charge NUMERIC NOT NULL CHECK(unit_core_charge>=0),
  original_amount NUMERIC NOT NULL CHECK(original_amount>=0),
  open_quantity NUMERIC NOT NULL CHECK(open_quantity>=0),
  open_amount NUMERIC NOT NULL CHECK(open_amount>=0),
  status TEXT NOT NULL DEFAULT 'outstanding' CHECK(status IN ('outstanding','returned','credited','closed')),
  due_date DATE,
  purchase_reference TEXT,
  return_reference TEXT,
  credit_reference TEXT,
  notes TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  returned_at TIMESTAMPTZ,
  credited_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_core_obligations_open ON part_core_obligations(vendor_id,vendor_location_id,status,due_date) WHERE status<>'closed';
CREATE INDEX IF NOT EXISTS idx_core_obligations_part ON part_core_obligations(part_id,received_at DESC);

CREATE TABLE IF NOT EXISTS part_core_events(
  id BIGSERIAL PRIMARY KEY,
  core_obligation_id BIGINT NOT NULL REFERENCES part_core_obligations(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN ('created','returned','credited','closed','reopened','note')),
  quantity NUMERIC,
  amount NUMERIC,
  reference TEXT,
  notes TEXT,
  from_status TEXT,
  to_status TEXT,
  username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_core_events_obligation ON part_core_events(core_obligation_id,created_at,id);

INSERT INTO schema_migrations(migration_key) VALUES('030_customer_inspection_purchasing_cores') ON CONFLICT DO NOTHING;
