-- Cron jobs: move from JSON file to DB for per-user ownership
CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT '',
  schedule_type TEXT NOT NULL DEFAULT 'cron' CHECK(schedule_type IN ('cron','every','at')),
  schedule_value TEXT NOT NULL,
  timezone TEXT,
  prompt TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run TEXT,
  last_result TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_tenant ON cron_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_user ON cron_jobs(user_id);
