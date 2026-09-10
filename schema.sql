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
