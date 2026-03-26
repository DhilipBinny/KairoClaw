/**
 * WebChat channel — Fastify WebSocket plugin.
 *
 * Registers a `/ws` WebSocket route and handles the webchat protocol:
 * auth, chat messages, session management, status, and cron CRUD.
 *
 * Compatible with the original webchat.js message format.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { InboundMessage, GatewayConfig } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import type { AgentRunner } from './types.js';
import { AgentQueue } from '../queue/index.js';
import { SessionRepository } from '../db/repositories/session.js';
import { MessageRepository } from '../db/repositories/message.js';
import { hashApiKey } from '../auth/keys.js';
import { createModuleLogger } from '../observability/logger.js';
import { sanitizeInput, detectPromptInjection } from '../security/input.js';

const log = createModuleLogger('channel.web');

// ─── Connected client tracking ──────────────────────────────

const clients = new Map<WebSocket, { sessionKey: string }>();
const MAX_WS_CONNECTIONS = 50;

/**
 * Broadcast a message to authenticated webchat clients.
 * If `sessionKey` is provided, only send to clients bound to that session.
 */
export function broadcastToWeb(message: Record<string, unknown>, sessionKey?: string): void {
  const data = JSON.stringify(message);
  for (const [ws, meta] of clients) {
    try {
      if (ws.readyState === 1) {
        if (!sessionKey || meta.sessionKey === sessionKey) {
          ws.send(data);
        }
      } else {
        // Clean up dead connections
        clients.delete(ws);
      }
    } catch {
      clients.delete(ws);
    }
  }
}

// Periodic cleanup of dead WebSocket connections (every 60s)
let _cleanupInterval: ReturnType<typeof setInterval> | null = setInterval(() => {
  for (const [ws] of clients) {
    if (ws.readyState !== 1) {
      clients.delete(ws);
    }
  }
}, 60_000);

/** Stop the periodic dead-connection cleanup. Call during server shutdown. */
export function stopWebchatCleanup(): void {
  if (_cleanupInterval) {
    clearInterval(_cleanupInterval);
    _cleanupInterval = null;
  }
}

// ─── Helpers ────────────────────────────────────────────────

function safeTokenCompare(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  // Hash both values to fixed-length buffers — eliminates length-based timing leaks
  const hashA = new Uint8Array(crypto.createHash('sha256').update(String(a)).digest());
  const hashB = new Uint8Array(crypto.createHash('sha256').update(String(b)).digest());
  return crypto.timingSafeEqual(hashA, hashB);
}

// ─── Plugin ─────────────────────────────────────────────────

export interface WebchatPluginOptions {
  db: DatabaseAdapter;
  config: GatewayConfig;
  runner: AgentRunner;
  secretsStore?: { get: (ns: string, key: string) => string | undefined };
}

/**
 * Fastify plugin that registers the `/ws` WebSocket route for WebChat.
 */
export const webchatPlugin: FastifyPluginAsync<WebchatPluginOptions> = async (app, opts) => {
  const { db, config, runner, secretsStore } = opts;
  const tenantId = (config as unknown as Record<string, unknown>).tenantId as string || 'default';
  const queue = new AgentQueue();
  const sessionRepo = new SessionRepository(db);
  const messageRepo = new MessageRepository(db);

  // @fastify/websocket is registered at server level (index.ts)
  app.get('/ws', { websocket: true }, (socket: WebSocket, _req: FastifyRequest) => {
    if (clients.size >= MAX_WS_CONNECTIONS) {
      log.warn('WebSocket connection rejected: max connections reached');
      socket.close(1013, 'Too many connections');
      return;
    }

    const gatewayToken = secretsStore?.get('gateway', 'token') || config.gateway.token;
    let authenticated = !gatewayToken;
    let userResolved = false; // track if we've resolved the user identity
    if (!gatewayToken) {
      log.warn({ category: 'auth' }, 'No gateway token configured — WebChat is unauthenticated');
    }
    let clientId = `web-${Date.now()}`;
    let clientRole: 'admin' | 'user' = 'user'; // resolved during auth
    let authAttempts = 0;
    let lastActivity = Date.now();
    let boundSessionKey: string | null = null; // set on first chat.send, immutable after

    // Per-connection chat rate limit (30 messages/minute)
    const CHAT_RATE_LIMIT = 30;
    const CHAT_RATE_WINDOW = 60_000; // 1 minute
    const chatTimestamps: number[] = [];

    // ── Keepalive + Idle timeout ─────────────────
    const IDLE_TIMEOUT = 15 * 60_000; // 15 minutes
    let isAlive = true;
    socket.on('pong', () => {
      isAlive = true;
    });
    const keepalive = setInterval(() => {
      // Check idle timeout
      if (Date.now() - lastActivity > IDLE_TIMEOUT) {
        log.debug({ clientId }, 'WebSocket idle timeout — disconnecting');
        clients.delete(socket);
        socket.close(1000, 'Idle timeout');
        return;
      }
      if (!isAlive) {
        clients.delete(socket);
        socket.terminate();
        return;
      }
      isAlive = false;
      try {
        socket.ping();
      } catch {
        /* ignore */
      }
    }, 30_000);

    // ── Utility: safe send ───────────────────────
    function safeSend(data: Record<string, unknown>): void {
      try {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(data));
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.debug({ err: msg }, 'WebSocket send error');
      }
    }

    // ── Message handler ──────────────────────────
    socket.on('message', async (raw: Buffer | string) => {
      lastActivity = Date.now();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as Record<string, unknown>;
      } catch {
        safeSend({ type: 'error', message: 'Invalid JSON' });
        return;
      }

      // Auth message — resolve user identity from API key
      if (msg.type === 'auth') {
        if (authenticated && userResolved) {
          safeSend({ type: 'auth.ok' });
          return;
        }
        authAttempts++;
        if (authAttempts > 5) {
          safeSend({ type: 'auth.error', message: 'Too many auth attempts' });
          socket.close(1008, 'Too many auth attempts');
          return;
        }
        const token = msg.token as string | undefined;
        // Check against gateway token first
        let authValid = authenticated || safeTokenCompare(token, gatewayToken);
        // Always try to resolve user from API key — sets stable UUID for scoping
        if (token) {
          const keyHash = hashApiKey(token);
          const user = await db.get<{ id: string; active: number; role: string }>(
            'SELECT id, active, role FROM users WHERE api_key_hash = ?',
            [keyHash],
          );
          if (user) {
            if (!user.active) {
              safeSend({ type: 'auth.error', message: 'Account deactivated' });
              return;
            }
            authValid = true;
            clientId = user.id;
            clientRole = user.role === 'admin' ? 'admin' : 'user';
            userResolved = true;
          }
        }
        if (authValid) {
          authenticated = true;
          clients.set(socket, { sessionKey: 'main' });
          safeSend({ type: 'auth.ok' });
          log.info({ clientId, clientRole }, 'WebChat client authenticated');
        } else {
          safeSend({ type: 'auth.error', message: 'Invalid token' });
        }
        return;
      }

      // Not authenticated and not an auth message
      if (!authenticated) {
        safeSend({ type: 'error', message: 'Not authenticated. Send { type: "auth", token: "..." }' });
        return;
      }

      const requestId = `ws-${Date.now().toString(36)}`;

      try {
        switch (msg.type) {
          // ── Chat message ─────────────────────
          case 'chat.send': {
            // Rate limit: max 30 chat messages per minute per connection
            const now = Date.now();
            while (chatTimestamps.length > 0 && chatTimestamps[0] < now - CHAT_RATE_WINDOW) {
              chatTimestamps.shift();
            }
            if (chatTimestamps.length >= CHAT_RATE_LIMIT) {
              safeSend({ type: 'error', message: 'Rate limit exceeded — max 30 messages per minute' });
              return;
            }
            chatTimestamps.push(now);

            const sessionKey = (msg.sessionKey as string) || 'main';
            if (typeof sessionKey !== 'string' || sessionKey.length > 200) {
              safeSend({ type: 'error', message: 'Invalid session key' });
              return;
            }

            // Bind this connection to the first sessionKey it uses
            if (!boundSessionKey) {
              boundSessionKey = sessionKey;
              clients.set(socket, { sessionKey });
            } else if (boundSessionKey !== sessionKey) {
              safeSend({ type: 'error', message: 'Session key mismatch — reconnect to switch sessions' });
              return;
            }
            const rawText = typeof msg.text === 'string' ? msg.text.trim() : '';
            if (!rawText) {
              safeSend({ type: 'error', message: 'Empty message' });
              return;
            }
            if (rawText.length > 100_000) {
              safeSend({ type: 'error', message: 'Message too long (max 100KB)' });
              return;
            }

            // Input sanitization & prompt injection detection
            const text = sanitizeInput(rawText);
            const injection = detectPromptInjection(text);
            if (injection.suspicious) {
              log.warn({ patterns: injection.patterns, requestId }, 'Prompt injection patterns detected (webchat)');
            }

            // Extract images if provided
            const rawImages = Array.isArray(msg.images) ? msg.images as Array<{ data?: string; mimeType?: string; filename?: string }> : [];
            const images = rawImages
              .filter((img) => typeof img.data === 'string' && typeof img.mimeType === 'string')
              .map((img) => ({ data: img.data!, mimeType: img.mimeType!, filename: img.filename }));

            // Generate smart previews for uploaded files
            let fullText = text;
            const rawFiles = Array.isArray(msg.files) ? msg.files as Array<{ path?: string; name?: string }> : [];
            if (rawFiles.length > 0) {
              const workspace = config.agent.workspace;
              const previews: string[] = [];
              for (const f of rawFiles) {
                if (typeof f.path !== 'string' || f.path.includes('..') || path.isAbsolute(f.path)) continue;
                const resolved = path.join(workspace, f.path);
                if (!fs.existsSync(resolved)) {
                  previews.push(`[Document "${f.name || 'file'}" — file not found]`);
                  continue;
                }
                try {
                  const { generateFilePreview } = await import('../media/file-preview.js');
                  previews.push(await generateFilePreview(resolved, f.name || path.basename(f.path)));
                } catch {
                  previews.push(`[Document "${f.name || 'file'}" at ${f.path}]`);
                }
              }
              if (previews.length > 0) {
                fullText = `${previews.join('\n\n')}\n\n${text}`;
              }
            }

            const inbound: InboundMessage = {
              text: fullText,
              channel: 'web',
              chatId: `web:${sessionKey}`,
              chatType: 'private',
              userId: clientId,
              senderName: 'User',
              ...(images.length > 0 ? { images } : {}),
            };

            const runId = crypto.randomUUID().slice(0, 8);
            safeSend({ type: 'chat.ack', runId, requestId });

            // Broadcast typing to clients on the same session
            broadcastToWeb({ type: 'chat.typing', sessionKey, requestId }, sessionKey);

            try {
              const showThinking = config.agent?.thinking?.showThinking?.web ?? true;
              const result = await queue.enqueue(sessionKey, () =>
                runner(inbound, {
                  onDelta: (delta: string) => {
                    safeSend({
                      type: 'chat.delta',
                      runId,
                      sessionKey,
                      text: delta,
                      requestId,
                    });
                  },
                  onThinkingDelta: (config.agent?.thinking?.enabled && showThinking) ? (delta: string) => {
                    safeSend({
                      type: 'chat.thinking',
                      runId,
                      sessionKey,
                      text: delta,
                      requestId,
                    });
                  } : undefined,
                  onToolStart: (name: string, args: Record<string, unknown>) => {
                    safeSend({
                      type: 'chat.tool',
                      runId,
                      sessionKey,
                      status: 'start',
                      name,
                      args: Object.keys(args || {}),
                      requestId,
                    });
                  },
                  onToolEnd: (name: string, resultPreview: string) => {
                    safeSend({
                      type: 'chat.tool',
                      runId,
                      sessionKey,
                      status: 'end',
                      name,
                      preview: (resultPreview || '').slice(0, 200),
                      requestId,
                    });
                  },
                }),
              );

              safeSend({
                type: 'chat.done',
                runId,
                sessionKey,
                text: result.text || '',
                usage: result.usage,
                ...(result.media && result.media.length > 0 ? { media: result.media } : {}),
                requestId,
              });
            } catch (e: unknown) {
              const errMsg = e instanceof Error ? e.message : String(e);
              log.error({ err: errMsg, runId, requestId }, 'WebChat agent error');
              safeSend({
                type: 'chat.error',
                runId,
                message: errMsg,
                requestId,
              });
            }
            break;
          }

          // ── Chat history ─────────────────────
          case 'chat.history': {
            const sessionKey = (msg.sessionKey as string) || 'main';
            const sessionId = msg.sessionId as string | undefined;
            // Look up session by ID first, then by chatId pattern (web sessions only)
            const webSessions = (await sessionRepo.listByTenant(tenantId, 500))
              .filter((s) => s.channel === 'web');
            let session = sessionId
              ? webSessions.find((s) => s.id === sessionId)
              : webSessions.find((s) => s.chat_id === `web:${sessionKey}`);
            // Also try matching by session ID as sessionKey
            if (!session) {
              session = webSessions.find((s) => s.id === sessionKey);
            }
            if (!session) {
              safeSend({ type: 'chat.history.result', sessionKey, messages: [], requestId });
              break;
            }
            // Ownership check: non-admin users can only access their own sessions
            if (clientRole !== 'admin' && session.user_id && session.user_id !== clientId) {
              safeSend({ type: 'chat.history.result', sessionKey, messages: [], requestId });
              break;
            }
            const limit = (msg.limit as number) || 50;
            const rows = await messageRepo.listBySession(session.id);
            const messages = rows.slice(-limit).map((m) => ({
              role: m.role,
              content: m.content?.slice(0, 5000),
            }));
            safeSend({ type: 'chat.history.result', sessionKey, sessionId: session.id, messages, requestId });
            break;
          }

          // ── Session list ─────────────────────
          case 'sessions.list': {
            const sessions = await sessionRepo.listByTenant(tenantId, 100);
            // Show only web chat sessions with actual messages
            // Non-admin users only see their own sessions
            const webSessions = sessions
              .filter((s) => s.turns > 0 && s.channel === 'web')
              .filter((s) => clientRole === 'admin' || !s.user_id || s.user_id === clientId);

            // Batch-fetch first user message for titles
            const sIds = webSessions.map(s => s.id);
            const titleMap = new Map<string, string>();
            if (sIds.length > 0) {
              const placeholders = sIds.map(() => '?').join(',');
              const titleRows = await db.query<{ session_id: string; content: string }>(
                `SELECT m.session_id, m.content FROM messages m
                 INNER JOIN (
                   SELECT session_id, MIN(id) as min_id FROM messages
                   WHERE session_id IN (${placeholders}) AND role = 'user'
                   GROUP BY session_id
                 ) first ON m.id = first.min_id`,
                sIds,
              );
              for (const row of titleRows) {
                const text = row.content.slice(0, 80).replace(/\n/g, ' ');
                titleMap.set(row.session_id, text.length < row.content.length ? text + '...' : text);
              }
            }

            const list = webSessions
              .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
              .map((s) => {
                const chatKey = s.chat_id?.startsWith('web:') ? s.chat_id.slice(4) : s.chat_id || s.id;
                const metadata = JSON.parse(s.metadata || '{}');
                const title = metadata.title || titleMap.get(s.id) || '';
                return {
                  id: s.id,
                  sessionKey: chatKey,
                  channel: s.channel,
                  chatId: s.chat_id,
                  title,
                  turns: s.turns,
                  inputTokens: s.input_tokens,
                  outputTokens: s.output_tokens,
                  createdAt: s.created_at,
                  updatedAt: s.updated_at,
                };
              });
            safeSend({ type: 'sessions.list.result', sessions: list, requestId });
            break;
          }

          // ── Status ───────────────────────────
          case 'status': {
            safeSend({
              type: 'status.result',
              uptime: process.uptime(),
              model: config.model.primary,
              queue: queue.stats,
              requestId,
            });
            break;
          }

          // ── Ping / pong ──────────────────────
          case 'ping': {
            safeSend({ type: 'pong', ts: Date.now(), requestId });
            break;
          }

          default:
            safeSend({ type: 'error', message: `Unknown type: ${msg.type as string}`, requestId });
        }
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        log.error({ err: errMsg, type: msg.type, requestId }, 'WebChat message handler error');
        safeSend({ type: 'error', message: 'Internal server error', requestId });
      }
    });

    // ── Cleanup ──────────────────────────────────
    socket.on('close', () => {
      clearInterval(keepalive);
      clients.delete(socket);
      log.debug({ clientId }, 'WebChat client disconnected');
    });

    socket.on('error', (err: Error) => {
      log.debug({ err: err.message, clientId }, 'WebSocket error');
      clients.delete(socket);
    });

    // ── Initial greeting ─────────────────────────
    if (authenticated) {
      clients.set(socket, { sessionKey: 'main' });
      safeSend({ type: 'auth.ok' });
    } else {
      safeSend({ type: 'auth.required' });
    }
  });

  log.info('WebChat WebSocket plugin registered on /ws');
};
