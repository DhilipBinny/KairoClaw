import type { FastifyPluginAsync } from 'fastify';
import { findUserByApiKey } from '../auth/keys.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { getDb } from './utils.js';

export const registerAuthRoutes: FastifyPluginAsync = async (app) => {
  // Use the shared auth rate limiter from the auth middleware
  const authLimiter = (app as unknown as { authFailLimiter: RateLimiter }).authFailLimiter;

  // POST /api/v1/auth/login — validate API key and return user info
  app.post('/api/v1/auth/login', async (request, reply) => {
    if (authLimiter && !authLimiter.record(request.ip)) {
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

    if (authLimiter) authLimiter.reset(request.ip);

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
