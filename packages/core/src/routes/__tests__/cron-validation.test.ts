/**
 * #144 API-004 — cron creation/update must validate the request body and must
 * not let a client choose the job id or owner.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authPlugin } from '../../auth/middleware.js';
import { hashApiKey } from '../../auth/keys.js';
import { registerCronRoutes } from '../cron.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: FastifyInstance;
let adminKey: string;
let adminId: string;
let captured: any;

function createDb() {
  const sqlite = new Database(':memory:');
  const migrationsDir = path.join(__dirname, '..', '..', 'db', 'migrations', 'sqlite');
  for (const file of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  sqlite.prepare(`INSERT INTO tenants (id, name, slug) VALUES ('t1','Test','test')`).run();
  adminKey = 'agw_sk_admin_' + crypto.randomUUID();
  adminId = crypto.randomUUID();
  sqlite.prepare(
    `INSERT INTO users (id, tenant_id, name, role, api_key_hash, active, elevated) VALUES (?, 't1','Admin','admin',?,1,0)`
  ).run(adminId, hashApiKey(adminKey));
  return {
    async run(sql: string, p?: unknown[]) { return sqlite.prepare(sql).run(...(p || [])); },
    async get<T>(sql: string, p?: unknown[]) { return sqlite.prepare(sql).get(...(p || [])) as T; },
    async query<T>(sql: string, p?: unknown[]) { return sqlite.prepare(sql).all(...(p || [])) as T[]; },
    close() { sqlite.close(); },
  };
}

beforeAll(async () => {
  const db = createDb();
  const scheduler = {
    add: (spec: any) => { captured = spec; return { id: 'srv-id', ...spec }; },
    update: (_id: string, updates: any) => ({ id: _id, ...updates }),
    remove: () => true,
    run: async () => ({ lastResult: null }),
    list: () => [],
    listFresh: async () => [],
  };

  app = Fastify({ ajv: { customOptions: { allowUnionTypes: true } } });
  app.decorateRequest('ctx', null);
  app.addHook('preHandler', async (request) => { (request as any).ctx = { db }; });
  await app.register(authPlugin, { db: db as any });
  await app.register(registerCronRoutes, { scheduler: scheduler as any });
  await app.ready();
});

afterAll(async () => { await app.close(); });

const post = (body: unknown) => app.inject({
  method: 'POST', url: '/api/v1/admin/cron',
  headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
  payload: body as any,
});

describe('cron create validation (#144 API-004)', () => {
  it('rejects a body missing required schedule/prompt', async () => {
    expect((await post({ prompt: 'hi' })).statusCode).toBe(400);
    expect((await post({ schedule: { type: 'cron', value: '* * * * *' } })).statusCode).toBe(400);
  });

  it('rejects an invalid schedule type', async () => {
    const res = await post({ schedule: { type: 'whenever', value: 'x' }, prompt: 'hi' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-string prompt (object cannot coerce)', async () => {
    const res = await post({ schedule: { type: 'cron', value: '* * * * *' }, prompt: { bad: true } });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a valid body and forces owner to the creating admin', async () => {
    captured = undefined;
    const res = await post({ schedule: { type: 'cron', value: '* * * * *' }, prompt: 'do it', name: 'job' });
    expect(res.statusCode).toBe(200);
    expect(captured.userId).toBe(adminId);
  });

  it('ignores a client-supplied id and userId', async () => {
    captured = undefined;
    const res = await post({
      id: 'attacker-chosen', userId: 'system',
      schedule: { type: 'cron', value: '* * * * *' }, prompt: 'x',
    });
    expect(res.statusCode).toBe(200);
    expect(captured.id).toBeUndefined();      // not forwarded — server generates it
    expect(captured.userId).toBe(adminId);    // forced to creator, not 'system'
  });
});
