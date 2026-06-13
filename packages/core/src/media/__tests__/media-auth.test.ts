/**
 * Media route auth (#104): the media endpoint must not serve files to
 * unauthenticated callers who merely know a filename. Access requires either a
 * valid signed-URL grant or normal authentication.
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
import { registerMediaRoutes } from '../../routes/media.js';
import { MediaStore } from '../store.js';
import { createMediaUrlSigner } from '../signing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: FastifyInstance;
let store: MediaStore;
let signer: ReturnType<typeof createMediaUrlSigner>;
let filename: string;
let userKey: string;
let stateDir: string;

function createDb() {
  const sqlite = new Database(':memory:');
  const migrationsDir = path.join(__dirname, '..', '..', 'db', 'migrations', 'sqlite');
  for (const file of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  sqlite.prepare(`INSERT INTO tenants (id, name, slug) VALUES ('t1','Test','test')`).run();
  userKey = 'agw_sk_user_' + crypto.randomUUID();
  sqlite.prepare(
    `INSERT INTO users (id, tenant_id, name, role, api_key_hash, active, elevated) VALUES (?, 't1','U','user',?,1,0)`
  ).run(crypto.randomUUID(), hashApiKey(userKey));
  return {
    async run(sql: string, p?: unknown[]) { return sqlite.prepare(sql).run(...(p || [])); },
    async get<T>(sql: string, p?: unknown[]) { return sqlite.prepare(sql).get(...(p || [])) as T; },
    async query<T>(sql: string, p?: unknown[]) { return sqlite.prepare(sql).all(...(p || [])) as T[]; },
    close() { sqlite.close(); },
  };
}

beforeAll(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-auth-'));
  signer = createMediaUrlSigner(crypto.randomBytes(32));
  store = new MediaStore(stateDir, signer);
  filename = store.save(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png'); // fake PNG

  const db = createDb();
  app = Fastify();
  app.decorateRequest('ctx', null);
  app.addHook('preHandler', async (request) => {
    (request as any).ctx = { db, config: { agent: { workspace: stateDir } } };
  });
  await app.register(authPlugin, { db: db as any, mediaSigner: signer });
  await app.register(registerMediaRoutes, { mediaStore: store });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const get = (url: string, headers?: Record<string, string>) => app.inject({ method: 'GET', url, headers });

describe('media route auth (#104)', () => {
  it('serves a file via a valid signed URL (no auth header)', async () => {
    const url = store.getUrl(filename); // signed
    expect(url).toContain('sig=');
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(4);
  });

  it('rejects an unsigned, unauthenticated request', async () => {
    const res = await get(`/api/v1/media/${filename}`);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a tampered signature', async () => {
    const url = store.getUrl(filename);
    const tampered = url.replace(/sig=([^&]+)$/, (_m, s) => 'sig=' + (s.endsWith('A') ? s.slice(0, -1) + 'B' : s.slice(0, -1) + 'A'));
    const res = await get(tampered);
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired signature', async () => {
    const { expires, sig } = signer.sign(filename, -1000);
    const res = await get(`/api/v1/media/${filename}?expires=${expires}&sig=${sig}`);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a signature minted for a different file', async () => {
    const { expires, sig } = signer.sign('someoneelse.png');
    const res = await get(`/api/v1/media/${filename}?expires=${expires}&sig=${sig}`);
    expect(res.statusCode).toBe(401);
  });

  it('serves a file to an authenticated user without a signature', async () => {
    const res = await get(`/api/v1/media/${filename}`, { authorization: `Bearer ${userKey}` });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 (not 401) for a valid signature on a missing file', async () => {
    const missing = `${crypto.randomUUID()}.png`;
    const { expires, sig } = signer.sign(missing);
    const res = await get(`/api/v1/media/${missing}?expires=${expires}&sig=${sig}`);
    expect(res.statusCode).toBe(404);
  });
});
