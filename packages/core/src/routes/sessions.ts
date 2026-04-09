import type { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { SessionRepository } from '../db/repositories/session.js';
import { MessageRepository } from '../db/repositories/message.js';
import { ToolCallRepository } from '../db/repositories/tool-call.js';
import { getDb, getTenantId, assertSessionAccess, getConfig } from './utils.js';

export const registerSessionRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/v1/sessions — list sessions for current tenant
  app.get('/api/v1/sessions', async (request) => {
    const db = getDb(request);
    const tenantId = getTenantId(request);
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
      // Get first user message per session (compatible with both SQLite and PostgreSQL)
      const placeholders = sessionIds.map(() => '?').join(',');
      const rows = await db.query<{ session_id: string; content: string }>(
        `SELECT m.session_id, m.content FROM messages m
         INNER JOIN (
           SELECT session_id, MIN(id) as min_id FROM messages
           WHERE session_id IN (${placeholders}) AND role = 'user'
           GROUP BY session_id
         ) first ON m.id = first.min_id`,
        sessionIds,
      );
      for (const row of rows) {
        firstMsgMap.set(row.session_id, row.content);
      }
    }

    // Fetch user names for display
    const userIds = [...new Set(sessions.map(s => s.user_id).filter(Boolean))] as string[];
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
      return {
        ...s,
        title,
        user_name: s.user_id ? userNameMap.get(s.user_id) || null : null,
      };
    });

    return { sessions: enriched };
  });

  // GET /api/v1/sessions/:id — get session with messages
  app.get('/api/v1/sessions/:id', async (request, reply) => {
    const db = getDb(request);
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    const sessionRepo = new SessionRepository(db);
    const messageRepo = new MessageRepository(db);

    const session = await sessionRepo.getById(id, tenantId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (!assertSessionAccess(session, request, reply)) return;

    const messages = await messageRepo.listBySession(id);
    return { session, messages };
  });

  // GET /api/v1/sessions/:id/tool-calls — get tool calls for a session
  app.get('/api/v1/sessions/:id/tool-calls', async (request, reply) => {
    const db = getDb(request);
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    const sessionRepo = new SessionRepository(db);
    const toolCallRepo = new ToolCallRepository(db);

    const session = await sessionRepo.getById(id, tenantId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (!assertSessionAccess(session, request, reply)) return;

    const toolCalls = await toolCallRepo.listBySession(id, 500);

    // Truncate large args/results to prevent multi-MB API responses
    const truncated = toolCalls.map(tc => ({
      ...tc,
      arguments: tc.arguments && tc.arguments.length > 2000
        ? tc.arguments.slice(0, 2000) + '...[truncated]'
        : tc.arguments,
      result: tc.result && tc.result.length > 2000
        ? tc.result.slice(0, 2000) + '...[truncated]'
        : tc.result,
    }));

    return { toolCalls: truncated };
  });

  // PATCH /api/v1/sessions/:id — update session (rename)
  app.patch('/api/v1/sessions/:id', async (request, reply) => {
    const db = getDb(request);
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    const { title } = request.body as { title?: string };
    const sessionRepo = new SessionRepository(db);

    const session = await sessionRepo.getById(id, tenantId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (!assertSessionAccess(session, request, reply)) return;

    if (title !== undefined) {
      // Store title in metadata JSON
      const metadata = JSON.parse(session.metadata || '{}');
      metadata.title = title.slice(0, 200);
      await sessionRepo.update(id, { metadata: JSON.stringify(metadata) });
    }

    return { success: true };
  });

  // GET /api/v1/sessions/:id/debug-prompt?messageId=<id> — fetch recorded LLM entries for a turn by message ID
  app.get('/api/v1/sessions/:id/debug-prompt', async (request, reply) => {
    const db = getDb(request);
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    const query = request.query as { messageId?: string };

    // Admin only — debug data is sensitive
    if (request.user?.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin only' });
    }

    const sessionRepo = new SessionRepository(db);
    const session = await sessionRepo.getById(id, tenantId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    const config = getConfig(request);
    const workspace = config.agent?.workspace || 'workspace';
    const debugDir = path.resolve(workspace, 'debug', 'llm-requests');

    if (!fs.existsSync(debugDir)) {
      return reply.code(404).send({ error: 'No debug logs found. Enable debug.recordPrompt in settings first.' });
    }

    const targetMessageId = query.messageId ? parseInt(query.messageId) : null;
    type DebugEntry = { sessionId: string; ts: string; turn: number; messageId?: number };

    const found: DebugEntry[] = [];
    for (let daysAgo = 0; daysAgo <= 7; daysAgo++) {
      const d = new Date(Date.now() - daysAgo * 86400000);
      const date = d.toISOString().slice(0, 10);
      const file = path.join(debugDir, `${date}.jsonl`);
      if (!fs.existsSync(file)) continue;

      const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as DebugEntry;
          if (entry.sessionId !== id) continue;
          if (targetMessageId !== null && entry.messageId !== targetMessageId) continue;
          found.push(entry);
        } catch { /* skip malformed lines */ }
      }
      if (found.length > 0) break;
    }

    if (found.length === 0) {
      return reply.code(404).send({ error: 'No debug log found for this turn. Make sure debug.recordPrompt was enabled when this session ran.' });
    }

    return { entries: found };
  });

  // DELETE /api/v1/sessions/:id/messages/:messageId — delete a specific message
  app.delete('/api/v1/sessions/:id/messages/:messageId', async (request, reply) => {
    const db = getDb(request);
    const tenantId = getTenantId(request);
    const { id, messageId } = request.params as { id: string; messageId: string };
    const sessionRepo = new SessionRepository(db);
    const messageRepo = new MessageRepository(db);

    const session = await sessionRepo.getById(id, tenantId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (!assertSessionAccess(session, request, reply)) return;

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
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    const sessionRepo = new SessionRepository(getDb(request));

    const session = await sessionRepo.getById(id, tenantId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (!assertSessionAccess(session, request, reply)) return;

    // Delete session and all child records
    await sessionRepo.deleteWithCascade(id);
    return { success: true };
  });
};
