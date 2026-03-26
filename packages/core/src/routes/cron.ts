/**
 * Cron job admin routes.
 *
 * CRUD for scheduled/recurring agent tasks.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { CronScheduler } from '../cron/scheduler.js';
import { requireRole } from '../auth/middleware.js';
import { getDb } from './utils.js';

export interface CronRoutesOptions {
  scheduler: CronScheduler;
}

export const registerCronRoutes: FastifyPluginAsync<CronRoutesOptions> = async (app, opts) => {
  const { scheduler } = opts;

  // GET /api/v1/admin/cron — list cron jobs (with user names)
  app.get('/api/v1/admin/cron', { preHandler: [requireRole('admin')] }, async (request) => {
    const jobs = scheduler.list();
    // Enrich with user names
    const db = getDb(request);
    if (db) {
      const userIds = [...new Set(jobs.map(j => j.userId).filter(Boolean))] as string[];
      if (userIds.length > 0) {
        const placeholders = userIds.map(() => '?').join(',');
        const users = await db.query(`SELECT id, name FROM users WHERE id IN (${placeholders})`, userIds);
        const nameMap = new Map(users.map((u: any) => [u.id, u.name]));
        return { jobs: jobs.map(j => ({ ...j, userName: j.userId ? nameMap.get(j.userId) || null : null })) };
      }
    }
    return { jobs: jobs.map(j => ({ ...j, userName: null })) };
  });

  // POST /api/v1/admin/cron — create a cron job
  app.post('/api/v1/admin/cron', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;

    try {
      const job = scheduler.add(body as any);
      return { success: true, job };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ error: msg });
    }
  });

  // PATCH /api/v1/admin/cron/:id — update a cron job
  app.patch(
    '/api/v1/admin/cron/:id',
    { preHandler: [requireRole('admin')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, unknown>;

      try {
        const updated = scheduler.update(id, body as any);
        if (!updated) {
          return reply.code(404).send({ error: 'Job not found' });
        }
        return { success: true, job: updated };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(400).send({ error: msg });
      }
    },
  );

  // DELETE /api/v1/admin/cron/:id — delete a cron job
  app.delete(
    '/api/v1/admin/cron/:id',
    { preHandler: [requireRole('admin')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const removed = scheduler.remove(id);
      if (!removed) {
        return reply.code(404).send({ error: 'Job not found' });
      }
      return { success: true };
    },
  );

  // POST /api/v1/admin/cron/:id/run — run a job immediately
  app.post(
    '/api/v1/admin/cron/:id/run',
    { preHandler: [requireRole('admin')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const result = await scheduler.run(id);
        if (result.error) {
          return reply.code(404).send({ error: result.error });
        }
        return { success: true, lastResult: result.lastResult };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(500).send({ error: msg });
      }
    },
  );

  // GET /api/v1/my/cron — own cron jobs (any authenticated user)
  app.get('/api/v1/my/cron', async (request) => {
    const userId = request.user?.id;
    if (!userId) return { jobs: [] };
    const allJobs = scheduler.list();
    return { jobs: allJobs.filter(j => j.userId === userId) };
  });

  // PATCH /api/v1/my/cron/:id — update own cron job
  app.patch('/api/v1/my/cron/:id', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) return reply.code(401).send({ error: 'Not authenticated' });

    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;

    // Ownership check
    const job = scheduler.list().find(j => j.id === id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.userId !== userId) return reply.code(403).send({ error: 'Forbidden' });

    try {
      const updated = scheduler.update(id, body as any);
      if (!updated) return reply.code(404).send({ error: 'Job not found' });
      return { success: true, job: updated };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ error: msg });
    }
  });

  // DELETE /api/v1/my/cron/:id — delete own cron job
  app.delete('/api/v1/my/cron/:id', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) return reply.code(401).send({ error: 'Not authenticated' });

    const { id } = request.params as { id: string };

    // Ownership check
    const job = scheduler.list().find(j => j.id === id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.userId !== userId) return reply.code(403).send({ error: 'Forbidden' });

    scheduler.remove(id);
    return { success: true };
  });
};
