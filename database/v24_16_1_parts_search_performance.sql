-- ITTR v24.16.1 optional parts-search performance migration
-- Safe to run repeatedly.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_fullbay_parts_number_trgm
  ON fullbay_import_parts USING gin (part_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_fullbay_parts_description_trgm
  ON fullbay_import_parts USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_fullbay_parts_manufacturer_trgm
  ON fullbay_import_parts USING gin (manufacturer gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_fullbay_parts_vendor_trgm
  ON fullbay_import_parts USING gin (vendor gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_fullbay_parts_location_trgm
  ON fullbay_import_parts USING gin (location gin_trgm_ops);
