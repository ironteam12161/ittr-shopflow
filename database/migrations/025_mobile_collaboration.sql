-- ITTR v23.2 collaboration release
-- Work-order helper assignments and task runningBy are stored in app_state JSON.
-- Existing task_time_sessions already records mechanic_username per labor session.
INSERT INTO schema_migrations(migration_key) VALUES('025_mobile_collaboration') ON CONFLICT(migration_key) DO NOTHING;
