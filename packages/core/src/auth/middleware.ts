import type { FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { hashApiKey } from './keys.js';
import type { DatabaseAdapter } from '../db/index.js';
import type { AuditService } from '../security/audit.js';

export interface AuthUser {
  id: string;
  tenantId: string;
  name: string;
  role: 'admin' | 'user' | 'viewer';
}

// Extend Fastify request type
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    tenantId?: string;
  }
}

/**
 * Authentication plugin for Fastify.
 * Uses fastify-plugin to break encapsulation — hooks apply to ALL routes.
 */
export const authPlugin = fp<{ db: DatabaseAdapter; auditService?: AuditService }>(async (app, opts) => {
  const { db, auditService } = opts;

  app.decorateRequest('user', undefined);
  app.decorateRequest('tenantId', undefined);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for health check and public routes
    const publicPaths = ['/api/v1/health', '/api/v1/auth/login'];
    if (publicPaths.some(p => request.url === p || request.url.startsWith(p + '?'))) return;

    // Media files need to be loadable by <img> tags (no auth header possible)
    // Only bypass for actual file requests (uuid.ext pattern), not sub-routes
    if (/^\/api\/v1\/media\/[a-f0-9-]+\.[a-z0-9]+$/i.test(request.url.split('?')[0])) return;

    // Also skip non-API routes (static files, etc.)
    if (!request.url.startsWith('/api/')) return;

    const authHeader = request.headers.authorization;
    // Support ?token= query param for download links (browser can't set auth headers on <a href>)
    const queryToken = (request.query as Record<string, string>)?.token;
    if (!authHeader?.startsWith('Bearer ') && !queryToken) {
      reply.code(401).send({ error: 'Missing or invalid Authorization header', statusCode: 401 });
      return;
    }

    const apiKey = queryToken || authHeader!.slice(7);
    const keyHash = hashApiKey(apiKey);

    // Look up user by hashed API key
    const user = await db.get<{ id: string; tenant_id: string; name: string; role: string }>(
      'SELECT id, tenant_id, name, role FROM users WHERE api_key_hash = ?',
      [keyHash]
    );

    if (!user) {
      reply.code(401).send({ error: 'Invalid API key', statusCode: 401 });
      return;
    }

    const validRoles = ['admin', 'user', 'viewer'];
    if (!validRoles.includes(user.role)) {
      reply.code(401).send({ error: 'Unauthorized', statusCode: 401 });
      return;
    }

    request.user = {
      id: user.id,
      tenantId: user.tenant_id,
      name: user.name,
      role: user.role as 'admin' | 'user' | 'viewer',
    };
    request.tenantId = user.tenant_id;

    // Audit: authenticated API request
    try {
      await auditService?.log({
        tenantId: user.tenant_id,
        userId: user.id,
        action: 'auth.request',
        resource: request.url,
        details: { role: user.role, method: request.method },
        ipAddress: request.ip,
      });
    } catch { /* audit should not break auth */ }
  });
});

/**
 * Guard that requires a specific role.
 * Use as a preHandler on admin-only routes.
 */
export function requireRole(...roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      reply.code(401).send({ error: 'Not authenticated', statusCode: 401 });
      return;
    }
    if (!roles.includes(request.user.role)) {
      reply.code(403).send({ error: 'Insufficient permissions', statusCode: 403 });
      return;
    }
  };
}
