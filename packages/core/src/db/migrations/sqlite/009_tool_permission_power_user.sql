-- Add 'power_user' to tool_permissions permission CHECK constraint.
-- SQLite doesn't support ALTER CHECK, so we recreate the table.

CREATE TABLE tool_permissions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  tool_pattern TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'allow' CHECK(permission IN ('allow','deny','confirm','power_user')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO tool_permissions_new (id, tenant_id, role, tool_pattern, permission, created_at)
  SELECT id, tenant_id, role, tool_pattern, permission, created_at FROM tool_permissions;

DROP TABLE tool_permissions;
ALTER TABLE tool_permissions_new RENAME TO tool_permissions;

CREATE INDEX IF NOT EXISTS idx_tool_perms_tenant ON tool_permissions(tenant_id);
