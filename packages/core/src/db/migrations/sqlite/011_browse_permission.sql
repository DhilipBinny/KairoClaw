-- Add browse tool as power_user permission for existing deployments
INSERT OR IGNORE INTO tool_permissions (tenant_id, role, tool_pattern, permission)
SELECT t.id, 'user', 'browse', 'power_user'
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM tool_permissions tp
  WHERE tp.tenant_id = t.id AND tp.role = 'user' AND tp.tool_pattern = 'browse'
);
