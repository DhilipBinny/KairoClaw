import type { DatabaseAdapter } from '../db/index.js';
import type { ToolPermissionLevel } from '@agw/types';
import { ToolPermissionRepository } from '../db/repositories/tool-permission.js';

/**
 * Check whether a tool is allowed for a given user.
 *
 * All permission logic is driven by DB rules (tool_permissions table).
 * No hardcoded tool lists — admin controls everything from Settings UI.
 *
 * Order of checks:
 * 1. Admin → always allow
 * 2. DB permission rules (glob matching, most specific wins)
 *    - 'allow'      → allow for all users
 *    - 'deny'       → deny (admin only)
 *    - 'power_user' → allow only if user has elevated flag
 *    - 'confirm'    → allow but flag for confirmation
 * 3. No rules → allow (open by default for single-user setups)
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

  const repo = new ToolPermissionRepository(db);
  // Single query — checkPermission returns 'allow' when no rules match
  const permission = await repo.checkPermission(tenantId, userRole, toolName);

  // power_user: allow only if user has elevated flag
  if (permission === 'power_user') {
    return elevated ? 'allow' : 'deny';
  }

  return permission;
}
