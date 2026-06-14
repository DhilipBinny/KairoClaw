/**
 * #106 — API keys are hashed with HMAC-SHA256 keyed by a master-key-derived
 * pepper, with transparent migration of legacy unsalted SHA-256 hashes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {
  hashApiKey, legacyHashApiKey, setApiKeyPepper, deriveApiKeyPepper, findUserByApiKey, generateApiKey,
} from '../keys.js';

afterEach(() => setApiKeyPepper(null)); // reset global pepper between tests

function db() {
  const s = new Database(':memory:');
  s.prepare(`CREATE TABLE users (id TEXT PRIMARY KEY, api_key_hash TEXT)`).run();
  return {
    sqlite: s,
    async get<T>(sql: string, p?: unknown[]) { return s.prepare(sql).get(...(p || [])) as T | undefined; },
    async run(sql: string, p?: unknown[]) { return s.prepare(sql).run(...(p || [])); },
  };
}

describe('hashApiKey pepper', () => {
  it('falls back to legacy SHA-256 when no pepper is set', () => {
    setApiKeyPepper(null);
    const k = generateApiKey();
    expect(hashApiKey(k)).toBe(legacyHashApiKey(k));
  });

  it('produces a peppered HMAC distinct from SHA-256 when a pepper is set', () => {
    const k = generateApiKey();
    setApiKeyPepper(crypto.randomBytes(32));
    const h = hashApiKey(k);
    expect(h).not.toBe(legacyHashApiKey(k));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for a given pepper, and pepper derivation is stable', () => {
    const mk = crypto.randomBytes(32);
    const p1 = deriveApiKeyPepper(mk);
    const p2 = deriveApiKeyPepper(mk);
    expect(p1.equals(p2)).toBe(true);
    setApiKeyPepper(p1);
    const k = 'agw_sk_abc';
    expect(hashApiKey(k)).toBe(hashApiKey(k));
    expect(deriveApiKeyPepper(crypto.randomBytes(32)).equals(p1)).toBe(false);
  });
});

describe('findUserByApiKey migration', () => {
  it('finds and lazily upgrades a legacy SHA-256 row to the peppered hash', async () => {
    const d = db();
    const key = generateApiKey();
    // Seed as a legacy (unpeppered) hash.
    d.sqlite.prepare('INSERT INTO users (id, api_key_hash) VALUES (?, ?)').run('u1', legacyHashApiKey(key));

    setApiKeyPepper(crypto.randomBytes(32));
    const peppered = hashApiKey(key);
    expect(peppered).not.toBe(legacyHashApiKey(key));

    const row = await findUserByApiKey<{ id: string; api_key_hash: string }>(d, key);
    expect(row?.id).toBe('u1');
    // The stored hash is upgraded in place.
    const stored = d.sqlite.prepare('SELECT api_key_hash FROM users WHERE id = ?').get('u1') as { api_key_hash: string };
    expect(stored.api_key_hash).toBe(peppered);
  });

  it('finds a row already stored with the peppered hash', async () => {
    const d = db();
    setApiKeyPepper(crypto.randomBytes(32));
    const key = generateApiKey();
    d.sqlite.prepare('INSERT INTO users (id, api_key_hash) VALUES (?, ?)').run('u2', hashApiKey(key));
    const row = await findUserByApiKey<{ id: string }>(d, key);
    expect(row?.id).toBe('u2');
  });

  it('returns null for an unknown key', async () => {
    const d = db();
    setApiKeyPepper(crypto.randomBytes(32));
    d.sqlite.prepare('INSERT INTO users (id, api_key_hash) VALUES (?, ?)').run('u3', hashApiKey('agw_sk_real'));
    expect(await findUserByApiKey(d, 'agw_sk_wrong')).toBeNull();
  });

  it('works with no pepper (legacy-only deployment)', async () => {
    const d = db();
    setApiKeyPepper(null);
    const key = generateApiKey();
    d.sqlite.prepare('INSERT INTO users (id, api_key_hash) VALUES (?, ?)').run('u4', hashApiKey(key));
    const row = await findUserByApiKey<{ id: string }>(d, key);
    expect(row?.id).toBe('u4');
  });
});
