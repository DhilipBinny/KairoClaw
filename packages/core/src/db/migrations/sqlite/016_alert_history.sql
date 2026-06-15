CREATE TABLE IF NOT EXISTS alert_history (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  state TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '{}',
  fired_at TEXT,
  resolved_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alert_history_type ON alert_history(type);
CREATE INDEX IF NOT EXISTS idx_alert_history_created ON alert_history(created_at);
CREATE INDEX IF NOT EXISTS idx_alert_history_fingerprint ON alert_history(fingerprint);
