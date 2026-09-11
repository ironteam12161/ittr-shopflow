-- ITTR v23 stable task records
ALTER TABLE task_time_sessions
  ADD COLUMN IF NOT EXISTS task_name TEXT;

CREATE INDEX IF NOT EXISTS idx_task_sessions_uid
  ON task_time_sessions(work_order_id,task_uid,started_at DESC);

INSERT INTO schema_migrations(migration_key)
VALUES('023_stable_task_records')
ON CONFLICT(migration_key) DO NOTHING;
