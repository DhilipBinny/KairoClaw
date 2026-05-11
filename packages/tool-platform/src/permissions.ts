import type { ToolPermissionLevel } from '@agw/types';

export type PermissionChecker = (
  tenantId: string,
  userRole: string,
  toolName: string,
) => Promise<ToolPermissionLevel>;

export async function checkToolPermission(
  toolName: string,
  userRole: string,
  tenantId: string,
  elevated: boolean,
  checker: PermissionChecker,
): Promise<ToolPermissionLevel> {
  if (userRole === 'admin') return 'allow';

  const permission = await checker(tenantId, userRole, toolName);

  if (permission === 'power_user') {
    return elevated ? 'allow' : 'deny';
  }

  return permission;
}
