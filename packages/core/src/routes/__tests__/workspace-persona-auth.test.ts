/**
 * #144 API-005 — only admins may overwrite the global persona files
 * (IDENTITY.md / SOUL.md / RULES.md). A regular user must be rejected.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authPlugin } from '../../auth/middleware.js';
import { hashApiKey } from '../../auth/keys.js';
import { registerWorkspaceRoutes } from '../workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: FastifyInstance;
let adminKey: string;
let userKey: string;
let workspace: string;

function createDb() {
  const sqlite = new Database(':memory:');
  const migrationsDir = path.join(__dirname, '..', '..', 'db', 'migrations', 'sqlite');
  for (const file of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  sqlite.prepare(`INSERT INTO tenants (id, name, slug) VALUES ('t1','Test','test')`).run();
  adminKey = 'agw_sk_admin_' + crypto.randomUUID();
  userKey = 'agw_sk_user_' + crypto.randomUUID();
  sqlite.prepare(`INSERT INTO users (id, tenant_id, name, role, api_key_hash, active, elevated) VALUES (?, 't1','A','admin',?,1,0)`).run(crypto.randomUUID(), hashApiKey(adminKey));
  sqlite.prepare(`INSERT INTO users (id, tenant_id, name, role, api_key_hash, active, elevated) VALUES (?, 't1','U','user',?,1,0)`).run(crypto.randomUUID(), hashApiKey(userKey));
  return {
    async run(sql: string, p?: unknown[]) { return sqlite.prepare(sql).run(...(p || [])); },
    async get<T>(sql: string, p?: unknown[]) { return sqlite.prepare(sql).get(...(p || [])) as T; },
    async query<T>(sql: string, p?: unknown[]) { return sqlite.prepare(sql).all(...(p || [])) as T[]; },
    close() { sqlite.close(); },
  };
}

beforeAll(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-auth-'));
  const db = createDb();
  app = Fastify();
  app.decorateRequest('ctx', null);
  app.addHook('preHandler', async (request) => { (request as any).ctx = { db, config: { agent: { workspace } } }; });
  await app.register(authPlugin, { db: db as any });
  await app.register(registerWorkspaceRoutes);
  await app.ready();
});

afterAll(async () => { await app.close(); fs.rmSync(workspace, { recursive: true, force: true }); });

const put = (key: string) => app.inject({
  method: 'PUT', url: '/api/v1/workspace/files/IDENTITY.md',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  payload: { content: 'pwned' },
});

describe('persona file write authorization (#144 API-005)', () => {
  it('rejects a non-admin user with 403', async () => {
    const res = await put(userKey);
    expect(res.statusCode).toBe(403);
    expect(fs.existsSync(path.join(workspace, 'IDENTITY.md'))).toBe(false);
  });

  it('allows an admin', async () => {
    const res = await put(adminKey);
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(workspace, 'IDENTITY.md'), 'utf8')).toBe('pwned');
  });
});
