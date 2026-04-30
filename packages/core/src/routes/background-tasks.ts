/**
 * Background task admin view (Phase 10 TB-4).
 *
 * Read-only visibility into the process-wide `BackgroundTaskRegistry`.
 * Admin-only — there's no per-user isolation at the API layer because
 * the registry already scope-filters internally (non-admin list() only
 * sees tasks with matching scopeKey).
 *
 * Routes:
 *
 *   GET  /api/v1/admin/background-tasks
 *     Returns every task currently tracked by the registry, with
 *     status, elapsed time, task preview, and scopeKey. Admin sees all
 *     scopes. Shape is designed for a simple admin table render.
 *
 *   POST /api/v1/admin/background-tasks/:id/stop
 *     Aborts a running task. Returns the stop reason (killed /
 *     already-<status> / not-found / wrong-scope / ambiguous-prefix).
 *     Exists so admins can kill a task from the UI without needing
 *     to open a chat session and call task_stop from the agent side.
 */

import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../auth/middleware.js';
import { backgroundTaskRegistry } from '../agent/background-task-registry.js';

export const registerBackgroundTaskRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/v1/admin/background-tasks — list everything
  app.get(
    '/api/v1/admin/background-tasks',
    { preHandler: [requireRole('admin')] },
    async () => {
      // Admin sees all scopes — pass scopeKey=null + isAdmin=true so
      // the registry's list() returns every entry.
      const tasks = backgroundTaskRegistry.list(null, true);
      const now = Date.now();
      return {
        count: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.id,
          scopeKey: t.scopeKey,
          status: t.status,
          startedAt: t.startedAt,
          completedAt: t.completedAt ?? null,
          elapsedMs: (t.completedAt ?? now) - t.startedAt,
          task: t.task,
          resultPreview: t.resultText
            ? t.resultText.slice(0, 500) + (t.resultText.length > 500 ? '...' : '')
            : null,
          error: t.error ?? null,
        })),
      };
    },
  );

  // POST /api/v1/admin/background-tasks/:id/stop — kill a task
  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/background-tasks/:id/stop',
    { preHandler: [requireRole('admin')] },
    async (request, reply) => {
      const id = request.params.id;
      const reason = backgroundTaskRegistry.stop(id, null, true);
      if (reason === 'not-found') {
        return reply.code(404).send({
          error: `No background task with id "${id}" exists.`,
          reason,
        });
      }
      if (reason === 'wrong-scope') {
        // Can't happen with isAdmin=true but exhaustive switch is cheap.
        return reply.code(403).send({ error: 'wrong-scope', reason });
      }
      if (reason === 'ambiguous-prefix') {
        return reply.code(400).send({
          error: `Prefix "${id}" matches multiple tasks. Pass the full id.`,
          reason,
        });
      }
      return { ok: true, reason };
    },
  );

  // POST /api/v1/admin/background-tasks/clear — remove all completed tasks
  app.post(
    '/api/v1/admin/background-tasks/clear',
    { preHandler: [requireRole('admin')] },
    async () => {
      const count = await backgroundTaskRegistry.clearCompleted();
      return { ok: true, cleared: count };
    },
  );
};
