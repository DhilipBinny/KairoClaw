/**
 * Cron job admin routes.
 *
 * CRUD for scheduled/recurring agent tasks.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { CronScheduler } from '../cron/scheduler.js';
import { requireRole } from '../auth/middleware.js';

export interface CronRoutesOptions {
  scheduler: CronScheduler;
}

export const registerCronRoutes: FastifyPluginAsync<CronRoutesOptions> = async (app, opts) => {
  const { scheduler } = opts;

  // GET /api/v1/admin/cron — list cron jobs
  app.get('/api/v1/admin/cron', { preHandler: [requireRole('admin')] }, async () => {
    return { jobs: scheduler.list() };
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
};
