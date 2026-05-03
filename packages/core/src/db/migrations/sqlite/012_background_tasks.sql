-- Migration 012 — durable background_tasks table (Phase 10 TB-5)
--
-- BackgroundTaskRegistry started as in-memory only: tasks died with
-- the process. This migration persists every state transition so
-- tasks survive `kairobm restart`. On startup the registry re-hydrates
-- from this table with any surviving `running` rows marked as
-- `orphaned` (the original runAgent promise is gone; we have no way
-- to resume it, but the row is still viewable/stoppable via the
-- admin UI).
--
-- No foreign key into the sessions table: background tasks outlive
-- their parent session. `session_id` is informational only.

CREATE TABLE IF NOT EXISTS background_tasks (
  id             TEXT PRIMARY KEY,
  session_id     TEXT,
  scope_key      TEXT,
  task           TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('running', 'completed', 'error', 'killed', 'orphaned')),
  started_at     INTEGER NOT NULL,
  completed_at   INTEGER,
  result_text    TEXT,
  error          TEXT,
  tenant_id      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bgt_scope ON background_tasks(scope_key);
CREATE INDEX IF NOT EXISTS idx_bgt_status ON background_tasks(status);
CREATE INDEX IF NOT EXISTS idx_bgt_started ON background_tasks(started_at DESC);
