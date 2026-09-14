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
