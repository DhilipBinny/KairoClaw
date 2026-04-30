/**
 * Composite scoring tests — verifies tiering, recency decay, and type weights.
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
  it('PINNED.md chunks rank higher than PROFILE.md for same keyword match', async () => {
    await insertChunk(db, 'scopes/user-a/memory/PINNED.md', 'dark mode preference noted');
    await insertChunk(db, 'scopes/user-a/memory/PROFILE.md', 'dark mode preference noted');

    const results = await memorySystem.search('dark mode');
    expect(results.length).toBe(2);
    // PINNED should rank first (3x vs 1.5x tier multiplier)
    expect(results[0].filePath).toBe('scopes/user-a/memory/PINNED.md');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('PROFILE.md ranks higher than session notes for same keyword match', async () => {
    await insertChunk(db, 'scopes/user-a/memory/PROFILE.md', 'likes coffee every morning');
    await insertChunk(db, 'scopes/user-a/memory/sessions/2026-04-12.md', 'likes coffee every morning');

    const results = await memorySystem.search('coffee');
    expect(results.length).toBe(2);
    expect(results[0].filePath).toBe('scopes/user-a/memory/PROFILE.md');
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
    // Recent entry should score higher
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
});

describe('Decay by type', () => {
  it('[belief] tagged entries score lower than untagged (fact) entries', async () => {
    await insertChunk(db, 'scopes/user-a/memory/PROFILE.md', '[belief] User seems to prefer dark mode');
    await insertChunk(db, 'scopes/user-b/memory/PROFILE.md', 'User prefers dark mode confirmed');

    const results = await memorySystem.search('dark mode');
    expect(results.length).toBe(2);
    // Untagged (fact, weight=1.0) should outrank belief (weight=0.6)
    const belief = results.find(r => r.content.includes('[belief]'))!;
    const fact = results.find(r => !r.content.includes('[belief]'))!;
    expect(fact.score).toBeGreaterThan(belief.score);
  });

  it('[experience] tagged entries score between facts and beliefs', async () => {
    await insertChunk(db, 'memory/a.md', '[fact] The sky is blue');
    await insertChunk(db, 'memory/b.md', '[experience] The sky looked blue yesterday');
    await insertChunk(db, 'memory/c.md', '[belief] The sky might be blue');

    const results = await memorySystem.search('sky blue');
    expect(results.length).toBe(3);
    const scores = results.map(r => ({
      type: r.content.includes('[fact]') ? 'fact' : r.content.includes('[experience]') ? 'experience' : 'belief',
      score: r.score,
    }));
    const fact = scores.find(s => s.type === 'fact')!;
    const exp = scores.find(s => s.type === 'experience')!;
    const belief = scores.find(s => s.type === 'belief')!;
    expect(fact.score).toBeGreaterThan(exp.score);
    expect(exp.score).toBeGreaterThan(belief.score);
  });
});

describe('Composite scoring combined', () => {
  it('a recent pinned fact outranks an old session belief', async () => {
    const now = new Date().toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    await insertChunk(db, 'scopes/user-a/memory/PINNED.md', 'API key rotation needed', now);
    await insertChunk(db, 'scopes/user-a/memory/sessions/old.md', '[belief] API key rotation might be needed', thirtyDaysAgo);

    const results = await memorySystem.search('API key rotation');
    expect(results.length).toBe(2);
    // Pinned (3x) * fresh (1.0) * fact (1.0) >> session (1x) * old (~0.6) * belief (0.6)
    expect(results[0].filePath).toContain('PINNED.md');
    expect(results[0].score).toBeGreaterThan(results[1].score * 3);
  });
});
