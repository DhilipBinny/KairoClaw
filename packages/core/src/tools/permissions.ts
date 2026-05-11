import type { DatabaseAdapter } from '../db/index.js';
import type { ToolPermissionLevel } from '@agw/types';
import { ToolPermissionRepository } from '../db/repositories/tool-permission.js';
import { checkToolPermission as _check } from '@agw/tool-platform';

export async function checkToolPermission(
  toolName: string,
  userRole: string,
  db: DatabaseAdapter,
  tenantId: string,
  elevated = false,
): Promise<ToolPermissionLevel> {
  const repo = new ToolPermissionRepository(db);
  return _check(toolName, userRole, tenantId, elevated, (tid, role, tool) =>
    repo.checkPermission(tid, role, tool),
  );
}
