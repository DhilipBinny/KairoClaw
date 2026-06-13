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

// Body validation schemas (API-004). The scheduler also validates schedule
// semantics, but rejecting malformed bodies here gives callers a clear 400 and
// keeps unvalidated input from reaching scheduler.add/update.
const scheduleSchema = {
  type: 'object',
  required: ['type', 'value'],
  properties: {
    type: { type: 'string', enum: ['at', 'every', 'cron'] },
    value: { type: ['string', 'number'] },
    tz: { type: 'string' },
    timezone: { type: 'string' },
  },
} as const;

const cronCreateSchema = {
  type: 'object',
  required: ['schedule', 'prompt'],
  properties: {
    name: { type: 'string', maxLength: 200 },
    prompt: { type: 'string', minLength: 1, maxLength: 5000 },
    enabled: { type: 'boolean' },
    schedule: scheduleSchema,
    delivery: {}, // string or object; shape validated downstream
  },
} as const;

// Note: an update that includes `schedule` must send the WHOLE schedule object.
// scheduler.update() replaces the schedule wholesale (it doesn't deep-merge), so
// requiring type+value here prevents a partial `{schedule:{tz}}` from clobbering
// the existing type/value. Both shipping clients always send the full schedule.
const cronUpdateSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 200 },
    prompt: { type: 'string', maxLength: 5000 },
    enabled: { type: 'boolean' },
    schedule: scheduleSchema,
    delivery: {},
  },
} as const;

export const registerCronRoutes: FastifyPluginAsync<CronRoutesOptions> = async (app, opts) => {
  const { scheduler } = opts;

  // GET /api/v1/admin/cron — list cron jobs (with user names)
  app.get('/api/v1/admin/cron', { preHandler: [requireRole('admin')] }, async (request) => {
    const jobs = await scheduler.listFresh();
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
  app.post('/api/v1/admin/cron', { preHandler: [requireRole('admin')], schema: { body: cronCreateSchema } }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;

    try {
      // Never trust a client-supplied id or owner: the id is server-generated and
      // the job is owned by the admin who creates it (mirrors the #179 rule that
      // ownership cannot be forged/reassigned via the update route).
      const { id: _id, userId: _userId, ...rest } = body;
      const job = scheduler.add({ ...rest, userId: request.user!.id } as any);
      return { success: true, job };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ error: msg });
    }
  });

  // PATCH /api/v1/admin/cron/:id — update a cron job
  app.patch(
    '/api/v1/admin/cron/:id',
    { preHandler: [requireRole('admin')], schema: { body: cronUpdateSchema } },
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
    const allJobs = await scheduler.listFresh();
    return { jobs: allJobs.filter(j => j.userId === userId) };
  });

  // PATCH /api/v1/my/cron/:id — update own cron job
  app.patch('/api/v1/my/cron/:id', { schema: { body: cronUpdateSchema } }, async (request, reply) => {
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
