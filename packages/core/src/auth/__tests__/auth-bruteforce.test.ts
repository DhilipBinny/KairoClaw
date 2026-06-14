/**
 * #107 — failed API-key authentication is rate-limited on the Bearer/?token=
 * path (every API route), not just /auth/login, so key-guessing can't bypass
 * the login limiter via another endpoint.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authPlugin } from '../middleware.js';
import { hashApiKey } from '../keys.js';
import { AUTH_FAIL_RATE_LIMIT } from '../../constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let app: FastifyInstance;
let validKey: string;

function createDb() {
  const sqlite = new Database(':memory:');
  const dir = path.join(__dirname, '..', '..', 'db', 'migrations', 'sqlite');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  sqlite.prepare(`INSERT INTO tenants (id, name, slug) VALUES ('t1','T','t')`).run();
  validKey = 'agw_sk_' + crypto.randomUUID();
  sqlite.prepare(`INSERT INTO users (id, tenant_id, name, role, api_key_hash, active, elevated) VALUES (?, 't1','A','admin',?,1,0)`)
    .run(crypto.randomUUID(), hashApiKey(validKey));
  return {
    async run(s: string, p?: unknown[]) { return sqlite.prepare(s).run(...(p || [])); },
    async get<T>(s: string, p?: unknown[]) { return sqlite.prepare(s).get(...(p || [])) as T; },
    async query<T>(s: string, p?: unknown[]) { return sqlite.prepare(s).all(...(p || [])) as T[]; },
    close() { sqlite.close(); },
  };
}

beforeAll(async () => {
  app = Fastify();
  app.decorateRequest('ctx', null);
  const db = createDb();
  app.addHook('preHandler', async (r) => { (r as any).ctx = { db }; });
  await app.register(authPlugin, { db: db as any });
  app.get('/api/v1/ping', async () => ({ ok: true }));
  await app.ready();
});
afterAll(async () => { await app.close(); });

const hit = (key: string) => app.inject({ method: 'GET', url: '/api/v1/ping', headers: { authorization: `Bearer ${key}` } });

describe('failed-auth rate limiting (#107)', () => {
  it('blocks with 429 after too many failed key attempts, then a valid key resets', async () => {
    // Burn the failure budget with invalid keys.
    for (let i = 0; i < AUTH_FAIL_RATE_LIMIT; i++) {
      const r = await hit('agw_sk_wrong_' + i);
      expect(r.statusCode).toBe(401);
    }
    // Next failed attempt is now rate-limited.
    expect((await hit('agw_sk_wrong_final')).statusCode).toBe(429);

    // A valid key still authenticates AND clears the IP's failure count.
    expect((await hit(validKey)).statusCode).toBe(200);
    expect((await hit('agw_sk_wrong_again')).statusCode).toBe(401);
  });
});
