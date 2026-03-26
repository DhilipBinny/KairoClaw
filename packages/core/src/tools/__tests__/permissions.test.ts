import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { checkToolPermission } from '../permissions.js';

// Use in-memory SQLite for tests
let db: any;

// Minimal DatabaseAdapter wrapper around better-sqlite3
function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.prepare(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT, slug TEXT, plan TEXT DEFAULT 'community', settings TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT)
  `).run();
  sqlite.prepare(`INSERT INTO tenants VALUES ('test-tenant', 'Test', 'test', 'community', '{}', datetime('now'), datetime('now'))`).run();
  sqlite.prepare(`
    CREATE TABLE tool_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      role TEXT NOT NULL,
      tool_pattern TEXT NOT NULL,
      permission TEXT NOT NULL DEFAULT 'allow' CHECK(permission IN ('allow','deny','confirm','power_user')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  return {
    async run(sql: string, params?: unknown[]) { return sqlite.prepare(sql).run(...(params || [])); },
    async get<T>(sql: string, params?: unknown[]) { return sqlite.prepare(sql).get(...(params || [])) as T; },
    async query<T>(sql: string, params?: unknown[]) { return sqlite.prepare(sql).all(...(params || [])) as T[]; },
    close() { sqlite.close(); },
  };
}

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

describe('checkToolPermission', () => {
  // Admin always allowed
  it('admin always gets allow', async () => {
    expect(await checkToolPermission('exec', 'admin', db, 'test-tenant')).toBe('allow');
  });

  it('admin bypasses deny rules', async () => {
    await db.run("INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission) VALUES ('test-tenant', 'admin', 'exec', 'deny')");
    expect(await checkToolPermission('exec', 'admin', db, 'test-tenant')).toBe('allow');
  });

  // No rules = allow (open by default)
  it('no rules returns allow', async () => {
    expect(await checkToolPermission('read_file', 'user', db, 'test-tenant')).toBe('allow');
  });

  // Deny rule
  it('deny rule blocks tool', async () => {
    await db.run("INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission) VALUES ('test-tenant', 'user', 'exec', 'deny')");
    expect(await checkToolPermission('exec', 'user', db, 'test-tenant')).toBe('deny');
  });

  // Power user — not elevated
  it('power_user without elevated returns deny', async () => {
    await db.run("INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission) VALUES ('test-tenant', 'user', 'exec', 'power_user')");
    expect(await checkToolPermission('exec', 'user', db, 'test-tenant', false)).toBe('deny');
  });

  // Power user — elevated
  it('power_user with elevated returns allow', async () => {
    await db.run("INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission) VALUES ('test-tenant', 'user', 'exec', 'power_user')");
    expect(await checkToolPermission('exec', 'user', db, 'test-tenant', true)).toBe('allow');
  });

  // Confirm
  it('confirm rule returns confirm', async () => {
    await db.run("INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission) VALUES ('test-tenant', 'user', 'web_search', 'confirm')");
    expect(await checkToolPermission('web_search', 'user', db, 'test-tenant')).toBe('confirm');
  });

  // Glob matching
  it('wildcard * matches all tools', async () => {
    await db.run("INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission) VALUES ('test-tenant', 'user', '*', 'deny')");
    expect(await checkToolPermission('read_file', 'user', db, 'test-tenant')).toBe('deny');
    expect(await checkToolPermission('exec', 'user', db, 'test-tenant')).toBe('deny');
  });

  it('prefix glob matches MCP tools', async () => {
    await db.run("INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission) VALUES ('test-tenant', 'user', 'mcp__*', 'deny')");
    expect(await checkToolPermission('mcp__github__issues', 'user', db, 'test-tenant')).toBe('deny');
    expect(await checkToolPermission('read_file', 'user', db, 'test-tenant')).toBe('allow');
  });

  // Most specific wins
  it('exact match overrides glob', async () => {
    await db.run("INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission) VALUES ('test-tenant', 'user', '*', 'deny')");
    await db.run("INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission) VALUES ('test-tenant', 'user', 'read_file', 'allow')");
    expect(await checkToolPermission('read_file', 'user', db, 'test-tenant')).toBe('allow');
    expect(await checkToolPermission('exec', 'user', db, 'test-tenant')).toBe('deny');
  });

  // No match with rules present — allow (not deny)
  it('rules exist but no match returns allow', async () => {
    await db.run("INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission) VALUES ('test-tenant', 'user', 'exec', 'power_user')");
    expect(await checkToolPermission('read_file', 'user', db, 'test-tenant')).toBe('allow');
  });

  // Tenant isolation
  it('rules from other tenant do not apply', async () => {
    await db.run("INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission) VALUES ('other-tenant', 'user', 'exec', 'deny')");
    expect(await checkToolPermission('exec', 'user', db, 'test-tenant')).toBe('allow');
  });
});
