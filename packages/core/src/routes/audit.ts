/**
 * Audit log admin routes.
 *
 * Provides paginated access to the tamper-evident audit log
 * and chain integrity verification.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseAdapter } from '../db/index.js';
import { requireRole } from '../auth/middleware.js';
import { AuditService } from '../security/audit.js';

export const registerAuditRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/v1/admin/audit -- paginated audit log
  app.get('/api/v1/admin/audit', { preHandler: [requireRole('admin')] }, async (request) => {
    const db = (request as any).ctx.db as DatabaseAdapter;
    const tenantId = request.tenantId || 'default';
    const { limit = '100', offset = '0', action } = request.query as Record<string, string>;
    const audit = new AuditService(db);

    if (action) {
      return { entries: await audit.repo.listByAction(tenantId, action, parseInt(limit)) };
    }
    return { entries: await audit.getRecent(tenantId, parseInt(limit), parseInt(offset)) };
  });

  // GET /api/v1/admin/audit/verify -- verify chain integrity
  app.get('/api/v1/admin/audit/verify', { preHandler: [requireRole('admin')] }, async (request) => {
    const db = (request as any).ctx.db as DatabaseAdapter;
    const tenantId = request.tenantId || 'default';
    const audit = new AuditService(db);
    return await audit.verifyChain(tenantId);
  });
};
