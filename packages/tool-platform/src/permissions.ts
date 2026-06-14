import type { ToolPermissionLevel } from '@agw/types';

export type PermissionChecker = (
  tenantId: string,
  userRole: string,
  toolName: string,
) => Promise<ToolPermissionLevel | 'no_rule'>;

export async function checkToolPermission(
  toolName: string,
  userRole: string,
  tenantId: string,
  elevated: boolean,
  checker: PermissionChecker,
): Promise<ToolPermissionLevel> {
  const permission = await checker(tenantId, userRole, toolName);

  // No explicit rule: admins and regular users are allowed (full access by
  // default — the bare-metal/personal-assistant case), only viewers are denied.
  // Admins are NOT blanket-bypassed: an explicitly-configured rule below still
  // applies to them, so an owner can opt into a guardrail (e.g. confirm before a
  // destructive tool) or limit a potentially-compromised admin token.
  if (permission === 'no_rule') {
    return userRole === 'viewer' ? 'deny' : 'allow';
  }

  // Tool gated to elevated users. Admins count as elevated.
  if (permission === 'power_user') {
    return (elevated || userRole === 'admin') ? 'allow' : 'deny';
  }

  // Explicit rule (allow / deny / confirm) — honoured for every role, admin too.
  return permission;
}
