import type { FastifyPluginAsync } from 'fastify';
import { hashApiKey, generateApiKey } from '../auth/keys.js';
import type { DatabaseAdapter } from '../db/index.js';

// Per-IP login attempt tracking for brute-force protection
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_RATE_LIMIT = 5;        // max attempts per window
const LOGIN_RATE_WINDOW = 60_000;   // 1 minute window
import { LOGIN_MAP_MAX_SIZE } from '../constants.js';

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();

  // Evict expired entries if map is at capacity
  if (loginAttempts.size >= LOGIN_MAP_MAX_SIZE) {
    for (const [key, entry] of loginAttempts) {
      if (now > entry.resetAt) loginAttempts.delete(key);
    }
    // If still at capacity after cleanup, reject to protect memory
    if (loginAttempts.size >= LOGIN_MAP_MAX_SIZE) {
      return false;
    }
  }

  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_RATE_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= LOGIN_RATE_LIMIT;
}

// Periodic cleanup of expired entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 5 * 60_000);

export const registerAuthRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/v1/auth/login — validate API key and return user info
  app.post('/api/v1/auth/login', async (request, reply) => {
    // Per-IP rate limiting for brute-force protection
    if (!checkLoginRateLimit(request.ip)) {
      return reply.code(429).send({ error: 'Too many login attempts. Try again later.' });
    }

    const { apiKey } = request.body as { apiKey?: string };
    if (!apiKey) {
      return reply.code(400).send({ error: 'apiKey is required' });
    }

    const db = (request as any).ctx.db as DatabaseAdapter;
    const keyHash = hashApiKey(apiKey);
    const user = db.get<{ id: string; tenant_id: string; name: string; role: string; email: string }>(
      'SELECT id, tenant_id, name, role, email FROM users WHERE api_key_hash = ?',
      [keyHash]
    );

    if (!user) {
      return reply.code(401).send({ error: 'Invalid API key' });
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
