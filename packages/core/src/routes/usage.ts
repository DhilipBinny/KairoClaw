import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseAdapter } from '../db/index.js';
import { UsageRepository } from '../db/repositories/usage.js';
import { requireRole } from '../auth/middleware.js';

export const registerUsageRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/v1/admin/usage — usage stats
  app.get('/api/v1/admin/usage', { preHandler: [requireRole('admin')] }, async (request) => {
    const db = (request as any).ctx.db as DatabaseAdapter;
    const tenantId = request.tenantId || 'default';
    const days = parseInt((request.query as any)?.days || '30');
    const repo = new UsageRepository(db);
    return await repo.summarizeByTenant(tenantId, days);
  });
};
