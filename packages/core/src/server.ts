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

  const gw = context.config.gateway;
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      stream,
      base: { category: 'system' },
    },
    disableRequestLogging: true,
    trustProxy: gw?.trustProxy ?? false,
  });

  // CORS — env override > auto-derive from listen config
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean);
  const host = gw?.host || '0.0.0.0';
  const port = gw?.port || 18181;
  let corsOrigin: boolean | string[];
  if (allowedOrigins && allowedOrigins.length > 0) {
    corsOrigin = allowedOrigins;
  } else if (host === '0.0.0.0' || host === '::') {
    corsOrigin = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  } else {
    corsOrigin = [`http://${host}:${port}`, `http://localhost:${port}`];
  }

  await app.register(import('@fastify/cors'), {
    origin: corsOrigin,
    credentials: true,
  });
  await app.register(import('@fastify/multipart'), {
    limits: { fileSize: 100 * 1024 * 1024 },
  });
  await app.register(import('@fastify/rate-limit'), {
    max: RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    allowList: (req) => {
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
