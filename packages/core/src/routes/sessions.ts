import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseAdapter } from '../db/index.js';
import { SessionRepository } from '../db/repositories/session.js';
import { MessageRepository } from '../db/repositories/message.js';

export const registerSessionRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/v1/sessions — list sessions for current tenant
  app.get('/api/v1/sessions', async (request) => {
    const db = (request as any).ctx.db as DatabaseAdapter;
    const tenantId = request.tenantId || 'default';
    const repo = new SessionRepository(db);
    const limit = parseInt((request.query as any)?.limit || '50');
    let sessions = await repo.listByTenant(tenantId, limit);

    // Filter out internal/cron sessions (sub-agents, scheduled tasks)
    sessions = sessions.filter(s => s.channel !== 'internal' && s.channel !== 'cron');

    // Filter by user ownership if authenticated (non-admin sees only own sessions)
    if (request.user?.id && request.user.role !== 'admin') {
      sessions = sessions.filter(s => s.user_id === request.user!.id);
    }

    // Batch-fetch first user message for all sessions (avoids N+1 query)
    const sessionIds = sessions.filter(s => s.turns > 0).map(s => s.id);
    const firstMsgMap = new Map<string, string>();
    if (sessionIds.length > 0) {
      // Use a single query with GROUP BY to get the first user message per session
      const placeholders = sessionIds.map(() => '?').join(',');
      const rows = await db.query<{ session_id: string; content: string }>(
        `SELECT session_id, content FROM messages
         WHERE session_id IN (${placeholders}) AND role = 'user'
         GROUP BY session_id
         HAVING id = MIN(id)`,
        sessionIds,
      );
      for (const row of rows) {
        firstMsgMap.set(row.session_id, row.content);
      }
    }

    const enriched = sessions.map((s) => {
      const metadata = JSON.parse(s.metadata || '{}');
      let title = metadata.title || '';

      if (!title && s.turns > 0) {
        const content = firstMsgMap.get(s.id);
        if (content) {
          title = content.slice(0, 80).replace(/\n/g, ' ');
          if (content.length > 80) title += '...';
        }
      }
      return { ...s, title };
    });

    return { sessions: enriched };
  });

  // GET /api/v1/sessions/:id — get session with messages
  app.get('/api/v1/sessions/:id', async (request, reply) => {
    const db = (request as any).ctx.db as DatabaseAdapter;
    const { id } = request.params as { id: string };
    const sessionRepo = new SessionRepository(db);
    const messageRepo = new MessageRepository(db);

    const session = await sessionRepo.getById(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    // Ownership check: non-admin users can only access their own sessions
    if (request.user?.id && request.user.role !== 'admin' && session.user_id !== request.user.id) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const messages = await messageRepo.listBySession(id);
    return { session, messages };
  });

  // PATCH /api/v1/sessions/:id — update session (rename)
  app.patch('/api/v1/sessions/:id', async (request, reply) => {
    const db = (request as any).ctx.db as DatabaseAdapter;
    const { id } = request.params as { id: string };
    const { title } = request.body as { title?: string };
    const sessionRepo = new SessionRepository(db);

    const session = await sessionRepo.getById(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    // Ownership check
    if (request.user?.id && request.user.role !== 'admin' && session.user_id !== request.user.id) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    if (title !== undefined) {
      // Store title in metadata JSON
      const metadata = JSON.parse(session.metadata || '{}');
      metadata.title = title.slice(0, 200);
      await sessionRepo.update(id, { metadata: JSON.stringify(metadata) });
    }

    return { success: true };
  });

  // DELETE /api/v1/sessions/:id/messages/:messageId — delete a specific message
  app.delete('/api/v1/sessions/:id/messages/:messageId', async (request, reply) => {
    const db = (request as any).ctx.db as DatabaseAdapter;
    const { id, messageId } = request.params as { id: string; messageId: string };
    const sessionRepo = new SessionRepository(db);
    const messageRepo = new MessageRepository(db);

    const session = await sessionRepo.getById(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    // Ownership check
    if (request.user?.id && request.user.role !== 'admin' && session.user_id !== request.user.id) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    // Delete the message and any subsequent messages (to keep context clean)
    const msgId = parseInt(messageId);
    if (isNaN(msgId)) return reply.code(400).send({ error: 'Invalid message ID' });

    await messageRepo.deleteFromId(id, msgId);

    // Update session turn count
    const turns = await sessionRepo.countUserTurns(id);
    await sessionRepo.setTurns(id, turns);

    return { success: true };
  });

  // DELETE /api/v1/sessions/:id — delete session
  app.delete('/api/v1/sessions/:id', async (request, reply) => {
    const db = (request as any).ctx.db as DatabaseAdapter;
    const { id } = request.params as { id: string };
    const sessionRepo = new SessionRepository(db);

    const session = await sessionRepo.getById(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    // Ownership check: only session owner or admin can delete
    if (request.user?.id && session.user_id !== request.user.id && request.user.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    // Delete session and all child records
    await sessionRepo.deleteWithCascade(id);
    // TODO: clean up scoped memory entries related to this session's date
    return { success: true };
  });
};
