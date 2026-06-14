import type { FastifyPluginAsync } from 'fastify';
import { findUserByApiKey } from '../auth/keys.js';
import { RateLimiter } from '../auth/rate-limit.js';
import { getDb } from './utils.js';

// Per-IP login attempt tracking for brute-force protection (request.ip respects
// gateway.trustProxy, so behind a trusted proxy this keys on the real client).
const LOGIN_RATE_LIMIT = 5;        // max attempts per window
const LOGIN_RATE_WINDOW = 60_000;   // 1 minute window

export const registerAuthRoutes: FastifyPluginAsync = async (app) => {
  const loginLimiter = new RateLimiter(LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW);
  loginLimiter.startCleanup();
  app.addHook('onClose', async () => loginLimiter.stopCleanup());

  // POST /api/v1/auth/login — validate API key and return user info
  app.post('/api/v1/auth/login', async (request, reply) => {
    // Per-IP rate limiting for brute-force protection
    if (!loginLimiter.record(request.ip)) {
      return reply.code(429).send({ error: 'Too many login attempts. Try again later.' });
    }

    const { apiKey } = request.body as { apiKey?: string };
    if (!apiKey) {
      return reply.code(400).send({ error: 'apiKey is required' });
    }

    const db = getDb(request);
    const user = await findUserByApiKey<{ id: string; tenant_id: string; name: string; role: string; email: string; active: number; api_key_hash?: string | null }>(db, apiKey);

    if (!user) {
      return reply.code(401).send({ error: 'Invalid API key' });
    }

    if (!user.active) {
      return reply.code(403).send({ error: 'Account deactivated' });
    }

    return {
      user: { id: user.id, name: user.name, role: user.role, email: user.email },
      tenantId: user.tenant_id,
    };
  });

  // GET /api/v1/auth/me — get current user info (requires auth)
  app.get('/api/v1/auth/me', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Not authenticated' });
    }
    return { user: request.user };
  });
};
