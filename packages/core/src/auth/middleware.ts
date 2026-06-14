import type { FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { findUserByApiKey } from './keys.js';
import { RateLimiter } from './rate-limit.js';
import type { DatabaseAdapter } from '../db/index.js';
import type { AuditService } from '../security/audit.js';
import type { MediaUrlSigner } from '../media/signing.js';
import { AUTH_FAIL_RATE_LIMIT, AUTH_FAIL_RATE_WINDOW_MS } from '../constants.js';

const MEDIA_FILE_RE = /^\/api\/v1\/media\/([a-zA-Z0-9._-]+\.[a-z0-9]+)$/i;

export interface AuthUser {
  id: string;
  tenantId: string;
  name: string;
  role: 'admin' | 'user' | 'viewer';
  elevated: boolean;
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
export const authPlugin = fp<{ db: DatabaseAdapter; auditService?: AuditService; mediaSigner?: MediaUrlSigner }>(async (app, opts) => {
  const { db, auditService, mediaSigner } = opts;

  // Per-IP limiter on FAILED API-key auth. Applies to every Bearer/?token=
  // request (not just /auth/login), so key-guessing can't bypass the login
  // limiter via other routes. request.ip respects gateway.trustProxy.
  const authFailLimiter = new RateLimiter(AUTH_FAIL_RATE_LIMIT, AUTH_FAIL_RATE_WINDOW_MS);
  authFailLimiter.startCleanup();
  app.addHook('onClose', async () => authFailLimiter.stopCleanup());
  app.decorate('authFailLimiter', authFailLimiter);

  app.decorateRequest('user', undefined);
  app.decorateRequest('tenantId', undefined);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for health check and public routes
    const publicPaths = ['/api/v1/health', '/api/v1/auth/login'];
    if (publicPaths.some(p => request.url === p || request.url.startsWith(p + '?'))) return;

    // Media files are loaded by plain <img>/external fetchers that can't send an
    // Authorization header. Grant access only when the request carries a valid,
    // unexpired signed token; otherwise fall through to normal authentication
    // (a logged-in client can still load media with its Bearer/?token= key).
    const mediaMatch = request.url.split('?')[0].match(MEDIA_FILE_RE);
    if (mediaMatch && mediaSigner) {
      const q = request.query as Record<string, unknown> | undefined;
      const rawExpires = q?.expires;
      const sig = q?.sig;
      // Require canonical, single-valued params: Fastify yields string[] for
      // duplicated keys, so reject anything that isn't a plain decimal string
      // rather than relying on Number()/Buffer coercion to fail. The regex
      // charset excludes '%', so mediaMatch[1] is already the exact raw
      // filename that getUrl() signed — no decoding needed.
      if (
        typeof sig === 'string' &&
        typeof rawExpires === 'string' &&
        /^[0-9]+$/.test(rawExpires) &&
        mediaSigner.verify(mediaMatch[1], Number(rawExpires), sig, Date.now())
      ) {
        return;
      }
    }

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

    // Brute-force guard: snapshot whether this IP is already over its failed-auth
    // budget. A VALID key always authenticates (and clears the count), so the
    // owner is never locked out; only wrong keys are throttled — once over the
    // limit, a failed attempt returns 429 instead of 401.
    const wasLimited = authFailLimiter.isLimited(request.ip);
    const rejectFailure = (code: number, error: string) => {
      authFailLimiter.record(request.ip);
      reply.code(wasLimited ? 429 : code).send(
        wasLimited
          ? { error: 'Too many failed authentication attempts. Try again later.', statusCode: 429 }
          : { error, statusCode: code },
      );
    };

    // Look up user by hashed API key (accepts legacy SHA-256 hashes and upgrades
    // them to the peppered hash on the fly).
    const user = await findUserByApiKey<{ id: string; tenant_id: string; name: string; role: string; elevated: number; active: number; api_key_hash?: string | null }>(db, apiKey);

    if (!user) {
      rejectFailure(401, 'Invalid API key');
      return;
    }

    // Reject deactivated users (valid key — not a brute-force signal)
    if (!user.active) {
      reply.code(403).send({ error: 'Account deactivated', statusCode: 403 });
      return;
    }

    const validRoles = ['admin', 'user', 'viewer'];
    if (!validRoles.includes(user.role)) {
      rejectFailure(401, 'Unauthorized');
      return;
    }

    // Successful auth — clear this IP's failure count.
    authFailLimiter.reset(request.ip);

    request.user = {
      id: user.id,
      tenantId: user.tenant_id,
      name: user.name,
      role: user.role as 'admin' | 'user' | 'viewer',
      elevated: !!user.elevated,
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
