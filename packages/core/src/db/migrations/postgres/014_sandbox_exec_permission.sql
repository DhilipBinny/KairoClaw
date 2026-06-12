-- Add sandbox tools as allowed for user role (sandbox is safe for all users)
INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission)
SELECT t.id, 'user', 'sandbox_exec', 'allow'
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM tool_permissions tp
  WHERE tp.tenant_id = t.id AND tp.role = 'user' AND tp.tool_pattern = 'sandbox_exec'
)
ON CONFLICT DO NOTHING;

INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission)
SELECT t.id, 'user', 'sandbox_read_file', 'allow'
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM tool_permissions tp
  WHERE tp.tenant_id = t.id AND tp.role = 'user' AND tp.tool_pattern = 'sandbox_read_file'
)
ON CONFLICT DO NOTHING;

INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission)
SELECT t.id, 'user', 'sandbox_write_file', 'allow'
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM tool_permissions tp
  WHERE tp.tenant_id = t.id AND tp.role = 'user' AND tp.tool_pattern = 'sandbox_write_file'
)
ON CONFLICT DO NOTHING;

INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission)
SELECT t.id, 'user', 'sandbox_list_files', 'allow'
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM tool_permissions tp
  WHERE tp.tenant_id = t.id AND tp.role = 'user' AND tp.tool_pattern = 'sandbox_list_files'
)
ON CONFLICT DO NOTHING;
