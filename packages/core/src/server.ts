import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { DatabaseAdapter } from './db/index.js';
import type { GatewayConfig } from '@agw/types';
import { createServerLogger } from './observability/logger.js';
import { RATE_LIMIT_MAX } from './constants.js';

export interface ServerContext {
  db: DatabaseAdapter;
  config: GatewayConfig;
}

export async function createServer(context: ServerContext): Promise<FastifyInstance> {
  // Multistream logger: terminal + file (rotated) + ring buffer
  const stateDir = context.config._stateDir || process.env.AGW_STATE_DIR || '';
  const { stream } = createServerLogger(stateDir);

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      stream,
      // Tag all Fastify-internal logs (startup, listen, errors) with category
      base: { category: 'system' },
    },
    // Disable default request/response logging — we use a custom hook below
    disableRequestLogging: true,
  });

  // Register plugins
  // CORS — restrict to configured origins, fallback to same-origin
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean);
  await app.register(import('@fastify/cors'), {
    origin: allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : ['http://localhost:18181', 'http://localhost:5173'],
    credentials: true,
  });
  await app.register(import('@fastify/multipart'), {
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max for import
  });
  await app.register(import('@fastify/rate-limit'), {
    max: RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    allowList: (req) => {
      // Don't rate-limit static assets, WebSocket upgrades, or health checks
      const url = req.url || '';
      return url.startsWith('/_app/') || url.startsWith('/favicon') || url === '/ws' || url === '/api/v1/health';
    },
  });

  // Decorate request with context
  app.decorateRequest('ctx', null);
  app.addHook('onRequest', async (request) => {
    (request as unknown as { ctx: ServerContext }).ctx = context;
  });

  // Structured HTTP logging — skip noisy polling endpoints
  const SILENT_PATHS = ['/api/v1/admin/logs', '/api/v1/admin/channels/status', '/api/v1/admin/whatsapp/qr', '/api/v1/health'];
  app.addHook('onResponse', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (SILENT_PATHS.some(p => url.startsWith(p))) return;
    if (url.startsWith('/_app/') || url.startsWith('/favicon')) return;
    request.log.info({
      category: 'http',
      method: request.method,
      url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    }, `${request.method} ${url} ${reply.statusCode}`);
  });

  // Security headers
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '1; mode=block');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), payment=()');
    if (process.env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  return app;
}
