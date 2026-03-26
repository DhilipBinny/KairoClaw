-- Add 'power_user' to tool_permissions permission CHECK constraint.
-- PostgreSQL supports ALTER TABLE ... DROP/ADD CONSTRAINT.

ALTER TABLE tool_permissions DROP CONSTRAINT IF EXISTS tool_permissions_permission_check;
ALTER TABLE tool_permissions ADD CONSTRAINT tool_permissions_permission_check
  CHECK (permission IN ('allow', 'deny', 'confirm', 'power_user'));
