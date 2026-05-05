-- Migration 012 — durable background_tasks table (Phase 10)
--
-- PostgreSQL equivalent of sqlite/012_background_tasks.sql.
-- Persists background task state so tasks survive process restarts.
-- On startup, rows still marked 'running' are flipped to 'orphaned'.

CREATE TABLE IF NOT EXISTS background_tasks (
  id             TEXT PRIMARY KEY,
  session_id     TEXT,
  scope_key      TEXT,
  task           TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('running', 'completed', 'error', 'killed', 'orphaned')),
  started_at     BIGINT NOT NULL,
  completed_at   BIGINT,
  result_text    TEXT,
  error          TEXT,
  tenant_id      TEXT,
  created_at     TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE INDEX IF NOT EXISTS idx_bgt_scope ON background_tasks(scope_key);
CREATE INDEX IF NOT EXISTS idx_bgt_status ON background_tasks(status);
CREATE INDEX IF NOT EXISTS idx_bgt_started ON background_tasks(started_at DESC);
