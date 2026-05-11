import { ToolRegistry as BaseToolRegistry } from '@agw/tool-platform';
import type { AuditService } from '../security/audit.js';
import { ToolCallRepository } from '../db/repositories/tool-call.js';
import { ToolPermissionRepository } from '../db/repositories/tool-permission.js';
import type { DatabaseAdapter } from '../db/index.js';

export class ToolRegistry extends BaseToolRegistry {
  setAuditService(audit: AuditService): void {
    this.setAuditLogger(audit);
  }

  setPermissionCheckerFromDb(db: DatabaseAdapter): void {
    const repo = new ToolPermissionRepository(db);
    this.setPermissionChecker((tenantId, userRole, toolName) =>
      repo.checkPermission(tenantId, userRole, toolName),
    );
  }

  setToolCallRecorderFromDb(db: DatabaseAdapter): void {
    this.setToolCallRecorder({
      async record(entry) {
        const repo = new ToolCallRepository(db);
        await repo.record(entry);
      },
    });
  }
}
