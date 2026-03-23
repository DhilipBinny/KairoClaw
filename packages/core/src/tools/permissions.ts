import type { DatabaseAdapter } from '../db/index.js';
import type { ToolPermissionLevel } from '@agw/types';
import { ToolPermissionRepository } from '../db/repositories/tool-permission.js';

/**
 * Check whether a tool is allowed for a given user role.
 *
 * Delegates to ToolPermissionRepository which supports glob matching
 * and picks the most specific pattern match. If no permission rules
 * exist for the tenant/role, the default is 'allow' (open by default
 * for single-user setups).
 */
export async function checkToolPermission(
  toolName: string,
  userRole: string,
  db: DatabaseAdapter,
  tenantId: string,
): Promise<ToolPermissionLevel> {
  const repo = new ToolPermissionRepository(db);
  const permissions = await repo.listByTenantAndRole(tenantId, userRole);

  // If no permission rules are configured, default to allow
  if (permissions.length === 0) {
    return 'allow';
  }

  return await repo.checkPermission(tenantId, userRole, toolName);
}
