/**
 * REST API channel for programmatic chat access.
 *
 * POST /api/v1/chat       — send a message and receive a streaming SSE response
 * POST /api/v1/chat/sync  — send a message and receive a blocking JSON response
 *
 * Both endpoints require authentication via Bearer token in the Authorization header.
 */

import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { InboundMessage, ChatRequest, ChatResponse } from '@agw/types';
import type { AgentRunner } from './types.js';
import { createModuleLogger } from '../observability/logger.js';
import { sanitizeInput, detectPromptInjection } from '../security/input.js';

const log = createModuleLogger('system');

// ─── Per-user rate limiter ───────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000;    // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30;     // per user per window
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// Periodically clean up stale entries
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(key);
    }
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);
// Allow process to exit without waiting for the timer
if (cleanupTimer.unref) cleanupTimer.unref();

function checkRateLimit(userId: string, ip: string): { allowed: boolean; retryAfterMs: number } {
  const key = userId !== 'anonymous' ? `user:${userId}` : `ip:${ip}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    // Start a new window
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterMs: 0 };
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - entry.windowStart);
    return { allowed: false, retryAfterMs };
  }

  return { allowed: true, retryAfterMs: 0 };
}

// ─── Request / response schemas (Fastify JSON Schema) ───────

const chatBodySchema = {
  type: 'object' as const,
  required: ['message'],
  properties: {
    message: { type: 'string' as const, minLength: 1, maxLength: 100_000 },
    sessionId: { type: 'string' as const },
    model: { type: 'string' as const },
  },
};

// ─── Plugin ─────────────────────────────────────────────────

export interface ChatApiOptions {
  runner: AgentRunner;
}

/**
 * Register REST chat endpoints.
 */
export const registerChatRoutes: FastifyPluginAsync<ChatApiOptions> = async (app, opts) => {
  const { runner } = opts;

  // ── POST /api/v1/chat — SSE streaming ──────────────────
  app.post(
    '/api/v1/chat',
    { schema: { body: chatBodySchema } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as ChatRequest;
      const userId = request.user?.id || 'anonymous';
      const tenantId = request.tenantId || 'default';
      const requestId = `api-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;

      // Per-user rate limiting
      const rateCheck = checkRateLimit(userId, request.ip);
      if (!rateCheck.allowed) {
        log.warn({ userId, ip: request.ip, requestId }, 'Chat rate limit exceeded');
        return reply.code(429).send({
          error: 'Too many requests. Please try again later.',
          retryAfterMs: rateCheck.retryAfterMs,
          statusCode: 429,
        });
      }

      // Input sanitization & prompt injection detection
      const sanitizedText = sanitizeInput(body.message.trim());
      const injection = detectPromptInjection(sanitizedText);
      if (injection.suspicious) {
        log.warn({ patterns: injection.patterns, requestId }, 'Prompt injection patterns detected (api SSE)');
      }

      const inbound: InboundMessage = {
        text: sanitizedText,
        channel: 'api',
        chatId: `api:${userId}`,
        chatType: 'private',
        userId,
        senderName: request.user?.name || 'API User',
      };

      if (!inbound.text) {
        return reply.code(400).send({ error: 'Empty message', statusCode: 400 });
      }

      log.info({ requestId, userId: inbound.userId, len: inbound.text.length }, 'REST chat (SSE)');

      // Set SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Request-Id': requestId,
      });

      function sendSSE(event: string, data: unknown): void {
        try {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          /* client disconnected */
        }
      }

      let aborted = false;
      request.raw.on('close', () => {
        aborted = true;
      });

      try {
        const result = await runner(inbound, {
          onDelta: (delta: string) => {
            if (!aborted) {
              sendSSE('delta', { text: delta, requestId });
            }
          },
          onToolStart: (name: string, args: Record<string, unknown>) => {
            if (!aborted) {
              sendSSE('tool_start', { name, args: Object.keys(args || {}), requestId });
            }
          },
          onToolEnd: (name: string, resultPreview: string) => {
            if (!aborted) {
              sendSSE('tool_end', { name, preview: (resultPreview || '').slice(0, 200), requestId });
            }
          },
        });

        if (!aborted) {
          sendSSE('done', {
            text: result.text || '',
            usage: result.usage,
            requestId,
          });
        }
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        log.error({ err: errMsg, requestId }, 'REST chat SSE error');
        if (!aborted) {
          sendSSE('error', { message: errMsg, requestId });
        }
      } finally {
        if (!aborted) {
          try {
            reply.raw.end();
          } catch {
            /* ignore */
          }
        }
      }
    },
  );

  // ── POST /api/v1/chat/sync — blocking JSON response ───
  app.post(
    '/api/v1/chat/sync',
    { schema: { body: chatBodySchema } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as ChatRequest;
      const userId = request.user?.id || 'anonymous';
      const tenantId = request.tenantId || 'default';
      const requestId = `api-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;

      // Per-user rate limiting
      const rateSyncCheck = checkRateLimit(userId, request.ip);
      if (!rateSyncCheck.allowed) {
        log.warn({ userId, ip: request.ip, requestId }, 'Chat rate limit exceeded (sync)');
        return reply.code(429).send({
          error: 'Too many requests. Please try again later.',
          retryAfterMs: rateSyncCheck.retryAfterMs,
          statusCode: 429,
        });
      }

      // Input sanitization & prompt injection detection
      const sanitizedTextSync = sanitizeInput(body.message.trim());
      const injectionSync = detectPromptInjection(sanitizedTextSync);
      if (injectionSync.suspicious) {
        log.warn({ patterns: injectionSync.patterns, requestId }, 'Prompt injection patterns detected (api sync)');
      }

      const inbound: InboundMessage = {
        text: sanitizedTextSync,
        channel: 'api',
        chatId: `api:${userId}`,
        chatType: 'private',
        userId,
        senderName: request.user?.name || 'API User',
      };

      if (!inbound.text) {
        return reply.code(400).send({ error: 'Empty message', statusCode: 400 });
      }

      log.info({ requestId, userId: inbound.userId, len: inbound.text.length }, 'REST chat (sync)');

      try {
        const result = await runner(inbound);

        const response: ChatResponse = {
          text: result.text || null,
          sessionId: `api:${userId}`,
          usage: result.usage || { inputTokens: 0, outputTokens: 0 },
        };

        return reply.send(response);
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        log.error({ err: errMsg, requestId }, 'REST chat sync error');
        return reply.code(500).send({ error: errMsg, statusCode: 500 });
      }
    },
  );
};
