-- Add sandbox_exec as allowed for user role (sandbox is safe for all users)
INSERT OR IGNORE INTO tool_permissions (tenant_id, role, tool_pattern, permission)
SELECT t.id, 'user', 'sandbox_exec', 'allow'
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM tool_permissions tp
  WHERE tp.tenant_id = t.id AND tp.role = 'user' AND tp.tool_pattern = 'sandbox_exec'
);
