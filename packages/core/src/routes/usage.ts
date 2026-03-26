import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseAdapter } from '../db/index.js';
import { UsageRepository } from '../db/repositories/usage.js';
import { requireRole } from '../auth/middleware.js';

export const registerUsageRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/v1/admin/usage — usage stats (optionally per-user)
  app.get('/api/v1/admin/usage', { preHandler: [requireRole('admin')] }, async (request) => {
    const db = (request as any).ctx.db as DatabaseAdapter;
    const tenantId = request.tenantId || 'default';
    const days = parseInt((request.query as any)?.days || '30');
    const groupBy = (request.query as any)?.groupBy as string | undefined;
    const repo = new UsageRepository(db);

    const summary = await repo.summarizeByTenant(tenantId, days);

    if (groupBy === 'user') {
      const byUser = await repo.summarizeAllUsers(tenantId, days);
      // Fetch user names
      const userIds = byUser.map(r => r.user_id).filter(Boolean);
      const userNameMap = new Map<string, string>();
      if (userIds.length > 0) {
        const placeholders = userIds.map(() => '?').join(',');
        const userRows = await db.query<{ id: string; name: string }>(
          `SELECT id, name FROM users WHERE id IN (${placeholders})`,
          userIds,
        );
        for (const row of userRows) {
          userNameMap.set(row.id, row.name);
        }
      }
      return {
        ...summary,
        byUser: byUser.map(r => ({
          ...r,
          user_name: userNameMap.get(r.user_id) || 'Unknown',
        })),
      };
    }

    return summary;
  });

  // GET /api/v1/my/usage — own usage stats (any authenticated user)
  app.get('/api/v1/my/usage', async (request) => {
    const db = (request as any).ctx.db as DatabaseAdapter;
    const tenantId = request.tenantId || 'default';
    const userId = request.user?.id;
    if (!userId) return { totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {} };
    const days = parseInt((request.query as any)?.days || '30');
    const repo = new UsageRepository(db);
    return await repo.summarizeByUser(tenantId, userId, days);
  });
};
