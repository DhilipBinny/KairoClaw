-- Add foreign key constraints to audit_log table
-- SQLite requires table recreation to add FK constraints

PRAGMA foreign_keys = OFF
;

CREATE TABLE audit_log_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT,
  prev_hash TEXT,
  entry_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO audit_log_new SELECT * FROM audit_log;

DROP TABLE audit_log;

ALTER TABLE audit_log_new RENAME TO audit_log;

CREATE INDEX idx_audit_tenant ON audit_log(tenant_id);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_created ON audit_log(created_at);

PRAGMA foreign_keys = ON
