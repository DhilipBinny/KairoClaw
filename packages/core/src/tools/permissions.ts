import type { DatabaseAdapter } from '../db/index.js';
import type { ToolPermissionLevel } from '@agw/types';
import { ToolPermissionRepository } from '../db/repositories/tool-permission.js';

/**
 * Tools that require admin or elevated access.
 * Non-admin, non-elevated users are denied these tools.
 */
const DANGEROUS_TOOLS = ['exec', 'manage_cron', 'write_file'];

/**
 * Check whether a tool is allowed for a given user.
 *
 * Order of checks:
 * 1. Admin → always allow
 * 2. Dangerous tool + non-elevated user → deny
 * 3. DB permission rules (glob matching, most specific wins)
 * 4. No rules → allow (open by default for single-user setups)
 */
export async function checkToolPermission(
  toolName: string,
  userRole: string,
  db: DatabaseAdapter,
  tenantId: string,
  elevated = false,
): Promise<ToolPermissionLevel> {
  // Admin bypasses all checks
  if (userRole === 'admin') return 'allow';

  // Dangerous tools require elevated access for non-admins
  if (DANGEROUS_TOOLS.includes(toolName) && !elevated) {
    return 'deny';
  }

  const repo = new ToolPermissionRepository(db);
  const permissions = await repo.listByTenantAndRole(tenantId, userRole);

  // If no permission rules are configured, default to allow
  if (permissions.length === 0) {
    return 'allow';
  }

  return await repo.checkPermission(tenantId, userRole, toolName);
}
