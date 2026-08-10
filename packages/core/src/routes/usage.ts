import type { FastifyPluginAsync } from 'fastify';
import { UsageRepository } from '../db/repositories/usage.js';
import { requireRole } from '../auth/middleware.js';
import { getDb, getTenantId } from './utils.js';

export const registerUsageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/v1/admin/usage', { preHandler: [requireRole('admin')] }, async (request) => {
    const db = getDb(request);
    const tenantId = getTenantId(request);
    const days = parseInt((request.query as Record<string, string>)?.days || '30');
    const repo = new UsageRepository(db);

    const summary = await repo.summarizeByTenant(tenantId, days);
    const byUser = await repo.summarizeAllUsers(tenantId, days);

    return { ...summary, byUser };
  });

  app.get('/api/v1/my/usage', async (request) => {
    const db = getDb(request);
    const tenantId = getTenantId(request);
    const userId = request.user?.id;
    if (!userId) return { totalInput: 0, totalOutput: 0, totalCost: 0, totalRequests: 0, byModel: [], byDay: [] };
    const days = parseInt((request.query as Record<string, string>)?.days || '30');
    const repo = new UsageRepository(db);
    return await repo.summarizeByUser(tenantId, userId, days);
  });
};
