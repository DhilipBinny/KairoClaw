/**
 * Memory search isolation tests.
 * Tests the SQL filter logic that restricts memory search by scope.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

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

  const insert = sqlite.prepare('INSERT INTO memory_chunks (file_path, content) VALUES (?, ?)');
  // Global memory
  insert.run('memory/PROFILE.md', 'Global profile likes coffee and reading');
  // User A
  insert.run('scopes/user-a-uuid/memory/PROFILE.md', 'User A likes hiking and photography');
  insert.run('scopes/user-a-uuid/memory/sessions/2026-03-25.md', 'User A discussed project plans today');
  // User B (also uses "likes" keyword so search matches)
  insert.run('scopes/user-b-uuid/memory/PROFILE.md', 'User B likes tea and cooking');
  insert.run('scopes/user-b-uuid/memory/sessions/2026-03-25.md', 'User B talked about recipes today');
  // Group
  insert.run('scopes/group_telegram_-100123/memory/PROFILE.md', 'Group discusses tech news');

  return {
    query<T>(sql: string, params?: unknown[]) { return sqlite.prepare(sql).all(...(params || [])) as T[]; },
    close() { sqlite.close(); },
  };
}

// Replicates the exact SQL filter from memory/index.ts search()
function searchWithScope(query: string, scopeKey?: string | null) {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (queryTerms.length === 0) return [];
  const likeConditions = queryTerms.map(() => 'content LIKE ?');
  const likeParams = queryTerms.map(t => `%${t}%`);
  const conditions = [likeConditions.join(' OR ')];
  const params = [...likeParams];
  if (scopeKey) {
    conditions.push('(file_path LIKE ? OR file_path NOT LIKE ?)');
    params.push(`scopes/${scopeKey}/%`, 'scopes/%');
  }
  const whereClause = `WHERE ${conditions.map(c => `(${c})`).join(' AND ')}`;
  return db.query(`SELECT file_path, content FROM memory_chunks ${whereClause}`, params) as { file_path: string; content: string }[];
}

beforeEach(() => { db = createDb(); });
afterEach(() => { db.close(); });

describe('Memory search isolation', () => {
  it('no scope (admin) returns all chunks', () => {
    const paths = searchWithScope('likes').map((r: any) => r.file_path);
    expect(paths).toContain('memory/PROFILE.md');
    expect(paths).toContain('scopes/user-a-uuid/memory/PROFILE.md');
    expect(paths).toContain('scopes/user-b-uuid/memory/PROFILE.md');
  });

  it('user A scope returns own + global only', () => {
    const paths = searchWithScope('likes', 'user-a-uuid').map((r: any) => r.file_path);
    expect(paths).toContain('memory/PROFILE.md');
    expect(paths).toContain('scopes/user-a-uuid/memory/PROFILE.md');
    expect(paths).not.toContain('scopes/user-b-uuid/memory/PROFILE.md');
    expect(paths).not.toContain('scopes/group_telegram_-100123/memory/PROFILE.md');
  });

  it('user B scope returns own + global only', () => {
    const paths = searchWithScope('likes', 'user-b-uuid').map((r: any) => r.file_path);
    expect(paths).toContain('memory/PROFILE.md');
    expect(paths).toContain('scopes/user-b-uuid/memory/PROFILE.md');
    expect(paths).not.toContain('scopes/user-a-uuid/memory/PROFILE.md');
  });

  it('sentinel scope returns global only', () => {
    const paths = searchWithScope('likes', '__no_scope__').map((r: any) => r.file_path);
    expect(paths).toContain('memory/PROFILE.md');
    expect(paths.every((p: string) => !p.startsWith('scopes/'))).toBe(true);
  });

  it('group scope returns own group + global', () => {
    const paths = searchWithScope('discusses', 'group_telegram_-100123').map((r: any) => r.file_path);
    expect(paths).toContain('scopes/group_telegram_-100123/memory/PROFILE.md');
    expect(paths.some((p: string) => p.includes('user-a'))).toBe(false);
    expect(paths.some((p: string) => p.includes('user-b'))).toBe(false);
  });

  it('user A cannot find user B content', () => {
    const paths = searchWithScope('cooking recipes', 'user-a-uuid').map((r: any) => r.file_path);
    expect(paths.some((p: string) => p.includes('user-b'))).toBe(false);
  });

  it('empty query returns nothing', () => {
    expect(searchWithScope('', 'user-a-uuid').length).toBe(0);
  });
});
