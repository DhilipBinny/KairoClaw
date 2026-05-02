/**
 * Composite scoring tests — verifies path-tier boost, recency decay,
 * configurable knobs, and the invalid-date guard.
 *
 * Type-decay tagging ([fact]/[belief]/[experience]) was specified
 * but the memory extraction pipeline never produces those tags, so
 * the multiplier was always 1.0. The corresponding tests were
 * dropped along with the dead-code path. PINNED.md tier was also
 * dropped because no feature in this codebase ever writes that file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemorySystem } from '../index.js';

let memorySystem: MemorySystem;
let db: any;

function createDb() {
  const sqlite = new Database(':memory:');
  sqlite.prepare(`
    CREATE TABLE memory_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      content TEXT NOT NULL,
      line_start INTEGER DEFAULT 0,
      line_end INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
  return {
    query: async (sql: string, params?: unknown[]) => sqlite.prepare(sql).all(...(params || [])),
    get: async (sql: string, params?: unknown[]) => sqlite.prepare(sql).get(...(params || [])),
    run: async (sql: string, params?: unknown[]) => { sqlite.prepare(sql).run(...(params || [])); },
    transaction: async (fn: () => Promise<void>) => { await fn(); },
  };
}

function insertChunk(sqlite: any, filePath: string, content: string, updatedAt?: string) {
  const at = updatedAt || new Date().toISOString();
  sqlite.run(
    'INSERT INTO memory_chunks (file_path, content, updated_at) VALUES (?, ?, ?)',
    [filePath, content, at],
  );
}

beforeEach(async () => {
  db = createDb();
  memorySystem = new MemorySystem(db as any, '/tmp/test-workspace');
  // Mark as initialized without file indexing
  (memorySystem as any).initialized = true;
});

describe('Memory tiering', () => {
  it('PROFILE.md ranks higher than session notes for same keyword match', async () => {
    await insertChunk(db, 'scopes/user-a/memory/PROFILE.md', 'likes coffee every morning');
    await insertChunk(db, 'scopes/user-a/memory/sessions/2026-04-12.md', 'likes coffee every morning');

    const results = await memorySystem.search('coffee');
    expect(results.length).toBe(2);
    expect(results[0].filePath).toBe('scopes/user-a/memory/PROFILE.md');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});

describe('Recency decay', () => {
  it('recent entries score higher than old entries with same content', async () => {
    const now = new Date().toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    await insertChunk(db, 'scopes/user-a/memory/PROFILE.md', 'project deadline is Friday', now);
    await insertChunk(db, 'scopes/user-b/memory/PROFILE.md', 'project deadline is Friday', thirtyDaysAgo);

    const results = await memorySystem.search('project deadline');
    expect(results.length).toBe(2);
    expect(results[0].filePath).toBe('scopes/user-a/memory/PROFILE.md');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('14-day-old entry scores roughly half the recency boost of a fresh entry', async () => {
    const now = new Date().toISOString();
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    await insertChunk(db, 'memory/fresh.md', 'testing recency scoring', now);
    await insertChunk(db, 'memory/old.md', 'testing recency scoring', fourteenDaysAgo);

    const results = await memorySystem.search('recency scoring');
    expect(results.length).toBe(2);
    const freshScore = results.find(r => r.filePath === 'memory/fresh.md')!.score;
    const oldScore = results.find(r => r.filePath === 'memory/old.md')!.score;
    // Fresh: keyword * 1.0 * (0.5 + 0.5 * 1.0) = keyword * 1.0
    // 14-day: keyword * 1.0 * (0.5 + 0.5 * 0.5) = keyword * 0.75
    const ratio = oldScore / freshScore;
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(0.85);
  });

  it('returns finite scores when updated_at is malformed (NaN guard)', async () => {
    await insertChunk(db, 'memory/bad.md', 'content for ranking', 'not-a-real-date');
    await insertChunk(db, 'memory/good.md', 'content for ranking', new Date().toISOString());

    const results = await memorySystem.search('content ranking');
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it('treats future updated_at timestamps as "now" instead of going negative', async () => {
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    await insertChunk(db, 'memory/future.md', 'content x', future);
    await insertChunk(db, 'memory/now.md', 'content x', new Date().toISOString());

    const results = await memorySystem.search('content x');
    expect(results.length).toBe(2);
    for (const r of results) expect(Number.isFinite(r.score)).toBe(true);
  });
});

describe('Configurable scoring knobs', () => {
  it('honours config.agent.memory.profileBoost when set', async () => {
    // Set a very large PROFILE boost to verify it actually flows through
    const cfg: any = { agent: { memory: { profileBoost: 10 } } };
    const ms = new MemorySystem(db as any, '/tmp/ws', cfg);
    (ms as any).initialized = true;

    await insertChunk(db, 'scopes/user-a/memory/PROFILE.md', 'topic xyz');
    await insertChunk(db, 'scopes/user-a/memory/sessions/old.md', 'topic xyz');

    const results = await ms.search('topic xyz');
    expect(results.length).toBe(2);
    const profile = results.find(r => r.filePath.endsWith('PROFILE.md'))!;
    const session = results.find(r => r.filePath.includes('sessions/'))!;
    // With profileBoost=10, PROFILE should outscore session by ~10x
    expect(profile.score / session.score).toBeGreaterThan(8);
  });

  it('honours config.agent.memory.recencyHalfLifeDays when set', async () => {
    // Very short half-life: 1 day. A 7-day-old entry should be heavily decayed.
    const cfg: any = { agent: { memory: { recencyHalfLifeDays: 1 } } };
    const ms = new MemorySystem(db as any, '/tmp/ws', cfg);
    (ms as any).initialized = true;

    const now = new Date().toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await insertChunk(db, 'memory/fresh.md', 'topic', now);
    await insertChunk(db, 'memory/old.md', 'topic', sevenDaysAgo);

    const results = await ms.search('topic');
    const fresh = results.find(r => r.filePath === 'memory/fresh.md')!;
    const old = results.find(r => r.filePath === 'memory/old.md')!;
    // After 7 half-lives the recency factor is ~1/128 → score floor is
    // (0.5 + 0.5*tiny) ≈ 0.5. Old should be ~half of fresh.
    expect(old.score / fresh.score).toBeLessThan(0.6);
    expect(old.score / fresh.score).toBeGreaterThan(0.4);
  });

  it('rejects non-positive profileBoost and falls back to default', async () => {
    const cfg: any = { agent: { memory: { profileBoost: 0 } } };
    const ms = new MemorySystem(db as any, '/tmp/ws', cfg);
    (ms as any).initialized = true;

    await insertChunk(db, 'scopes/user-a/memory/PROFILE.md', 'matter');
    await insertChunk(db, 'scopes/user-a/memory/sessions/x.md', 'matter');

    const results = await ms.search('matter');
    const profile = results.find(r => r.filePath.endsWith('PROFILE.md'))!;
    const session = results.find(r => r.filePath.includes('sessions/'))!;
    // Default 1.5x → PROFILE should still outrank session
    expect(profile.score).toBeGreaterThan(session.score);
  });
});
