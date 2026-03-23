/**
 * Audit service -- convenience wrapper around AuditRepository.
 *
 * Provides a simpler API for logging audit events and querying
 * the tamper-evident audit chain.
 */

import type { DatabaseAdapter } from '../db/index.js';
import { AuditRepository } from '../db/repositories/audit.js';

export class AuditService {
  readonly repo: AuditRepository;

  constructor(private db: DatabaseAdapter) {
    this.repo = new AuditRepository(db);
  }

  /** Log an audit event with auto-populated context. */
  async log(opts: {
    tenantId: string;
    userId?: string;
    action: string;
    resource?: string;
    details?: Record<string, unknown>;
    ipAddress?: string;
  }): Promise<void> {
    await this.repo.append(opts);
  }

  /** Get recent audit entries for a tenant. */
  async getRecent(tenantId: string, limit = 100, offset = 0) {
    return await this.repo.listByTenant(tenantId, limit, offset);
  }

  /** Verify audit chain integrity for a tenant. */
  async verifyChain(tenantId: string) {
    return await this.repo.verifyChain(tenantId);
  }
}
