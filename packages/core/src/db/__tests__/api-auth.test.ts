/**
 * API Auth + Admin Guard tests.
 * Uses Fastify's inject() to test HTTP endpoints without starting a real server.
 * Tests that every admin endpoint rejects non-admin users,
 * and that user-facing endpoints enforce ownership.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { authPlugin } from '../../auth/middleware.js';
import { hashApiKey } from '../../auth/keys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: FastifyInstance;
let adminKey: string;
let userKey: string;
let userId: string;
let adminId: string;

// Minimal DB adapter
function createDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const migrationsDir = path.join(__dirname, '..', 'migrations', 'sqlite');
  for (const file of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  // Seed tenant
  sqlite.prepare(`INSERT INTO tenants (id, name, slug) VALUES ('t1', 'Test', 'test')`).run();

  // Seed admin user
  adminKey = 'agw_sk_admin_test_key_' + crypto.randomUUID();
  adminId = crypto.randomUUID();
  sqlite.prepare(
    `INSERT INTO users (id, tenant_id, name, role, api_key_hash, active, elevated) VALUES (?, 't1', 'Admin', 'admin', ?, 1, 0)`
  ).run(adminId, hashApiKey(adminKey));

  // Seed regular user
  userKey = 'agw_sk_user_test_key_' + crypto.randomUUID();
  userId = crypto.randomUUID();
  sqlite.prepare(
    `INSERT INTO users (id, tenant_id, name, role, api_key_hash, active, elevated) VALUES (?, 't1', 'TestUser', 'user', ?, 1, 0)`
  ).run(userId, hashApiKey(userKey));

  // Seed sessions
  sqlite.prepare(
    `INSERT INTO sessions (id, tenant_id, user_id, channel, chat_id) VALUES ('sess-user', 't1', ?, 'web', 'web:test')`
  ).run(userId);
  sqlite.prepare(
    `INSERT INTO sessions (id, tenant_id, user_id, channel, chat_id) VALUES ('sess-admin', 't1', ?, 'web', 'web:admin')`
  ).run(adminId);

  return {
    async run(sql: string, params?: unknown[]) { return sqlite.prepare(sql).run(...(params || [])); },
    async get<T>(sql: string, params?: unknown[]) { return sqlite.prepare(sql).get(...(params || [])) as T; },
    async query<T>(sql: string, params?: unknown[]) { return sqlite.prepare(sql).all(...(params || [])) as T[]; },
    close() { sqlite.close(); },
  };
}

beforeAll(async () => {
  const db = createDb();
  app = Fastify();

  // Decorate with ctx (same pattern as production)
  // Note: 'tenantId' is decorated by authPlugin, so we skip it here
  app.decorateRequest('ctx', null);
  app.addHook('preHandler', async (request) => {
    (request as any).ctx = { db, config: { agent: { workspace: '/tmp/test-workspace' } } };
  });

  // Register auth plugin
  await app.register(authPlugin, { db: db as any });

  // Register routes
  const { registerUserRoutes } = await import('../../routes/users.js');
  const { registerUsageRoutes } = await import('../../routes/usage.js');
  const { registerSessionRoutes } = await import('../../routes/sessions.js');
  const { registerAuthRoutes } = await import('../../routes/auth.js');

  await app.register(registerAuthRoutes);
  await app.register(registerUserRoutes);
  await app.register(registerUsageRoutes);
  await app.register(registerSessionRoutes);

  // Health (no auth)
  app.get('/api/v1/health', async () => ({ status: 'ok' }));

  // User portal
  app.get('/api/v1/my/dashboard', async (request) => {
    if (!request.user) return { error: 'Not authenticated' };
    return { user: request.user };
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// ── Helpers ──────────────────────────────────────────────

function inject(method: string, url: string, key?: string, body?: any) {
  return app.inject({
    method: method as any,
    url,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { payload: body } : {}),
  });
}

// ── Authentication ───────────────────────────────────────

describe('Authentication', () => {
  it('rejects no auth header', async () => {
    const res = await inject('GET', '/api/v1/admin/users');
    expect(res.statusCode).toBe(401);
  });

  it('rejects invalid key', async () => {
    const res = await inject('GET', '/api/v1/admin/users', 'agw_sk_invalid');
    expect(res.statusCode).toBe(401);
  });

  it('accepts valid admin key', async () => {
    const res = await inject('GET', '/api/v1/admin/users', adminKey);
    expect(res.statusCode).toBe(200);
  });

  it('accepts valid user key for non-admin endpoint', async () => {
    const res = await inject('GET', '/api/v1/sessions', userKey);
    expect(res.statusCode).toBe(200);
  });

  it('health works without auth', async () => {
    const res = await inject('GET', '/api/v1/health');
    expect(res.statusCode).toBe(200);
  });
});

// ── Admin Guard ──────────────────────────────────────────

describe('Admin-only endpoints reject non-admin', () => {
  const endpoints = [
    ['GET', '/api/v1/admin/users'],
    ['GET', '/api/v1/admin/users/unlinked-sessions'],
    ['GET', '/api/v1/admin/tool-permissions/user'],
  ];

  for (const [method, url] of endpoints) {
    it(`${method} ${url} → 403 for user`, async () => {
      const res = await inject(method, url, userKey);
      expect(res.statusCode).toBe(403);
    });

    it(`${method} ${url} → 200 for admin`, async () => {
      const res = await inject(method, url, adminKey);
      expect(res.statusCode).toBe(200);
    });
  }

  it('POST /api/v1/admin/users → 403 for user', async () => {
    const res = await inject('POST', '/api/v1/admin/users', userKey, { name: 'Hack' });
    expect(res.statusCode).toBe(403);
  });

  it('PUT /api/v1/admin/tool-permissions/user → 403 for user', async () => {
    const res = await inject('PUT', '/api/v1/admin/tool-permissions/user', userKey, { permissions: [] });
    expect(res.statusCode).toBe(403);
  });
});

// ── Session Ownership ────────────────────────────────────

describe('Session ownership', () => {
  it('user sees only own sessions', async () => {
    const res = await inject('GET', '/api/v1/sessions', userKey);
    const data = JSON.parse(res.body);
    for (const s of data.sessions) {
      expect(s.user_id).toBe(userId);
    }
  });

  it('admin sees all sessions', async () => {
    const res = await inject('GET', '/api/v1/sessions', adminKey);
    const data = JSON.parse(res.body);
    expect(data.sessions.length).toBeGreaterThanOrEqual(2);
  });

  it('user cannot access admin session', async () => {
    const res = await inject('GET', '/api/v1/sessions/sess-admin', userKey);
    expect(res.statusCode).toBe(403);
  });

  it('user can access own session', async () => {
    const res = await inject('GET', '/api/v1/sessions/sess-user', userKey);
    expect(res.statusCode).toBe(200);
  });
});

// ── User Portal ──────────────────────────────────────────

describe('User portal', () => {
  it('/my/dashboard works for user', async () => {
    const res = await inject('GET', '/api/v1/my/dashboard', userKey);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).user.name).toBe('TestUser');
  });

  it('/my/dashboard rejects unauthenticated', async () => {
    const res = await inject('GET', '/api/v1/my/dashboard');
    expect(res.statusCode).toBe(401);
  });

  it('/my/usage works for user', async () => {
    const res = await inject('GET', '/api/v1/my/usage', userKey);
    expect(res.statusCode).toBe(200);
  });
});

// ── Self-Protection ──────────────────────────────────────

describe('Self-protection', () => {
  it('admin cannot deactivate themselves', async () => {
    const res = await inject('DELETE', `/api/v1/admin/users/${adminId}`, adminKey);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('yourself');
  });

  it('admin cannot delete themselves permanently', async () => {
    const res = await inject('DELETE', `/api/v1/admin/users/${adminId}/permanent`, adminKey);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('yourself');
  });
});

// ── Deactivated User ─────────────────────────────────────

describe('Deactivated user', () => {
  let deactivatedKey: string;
  let deactivatedId: string;

  beforeAll(async () => {
    const res = await inject('POST', '/api/v1/admin/users', adminKey, { name: 'ToDeactivate' });
    const data = JSON.parse(res.body);
    deactivatedKey = data.api_key;
    deactivatedId = data.user.id;
    await inject('DELETE', `/api/v1/admin/users/${deactivatedId}`, adminKey);
  });

  it('deactivated user gets 403', async () => {
    const res = await inject('GET', '/api/v1/sessions', deactivatedKey);
    expect(res.statusCode).toBe(403);
  });

  it('deactivated user login returns 403', async () => {
    const res = await inject('POST', '/api/v1/auth/login', undefined, { apiKey: deactivatedKey });
    expect(res.statusCode).toBe(403);
  });
});
