/**
 * Shared test helper — creates an in-memory SQLite DB with the full schema.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TestDb {
  run(sql: string, params?: unknown[]): Promise<any>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): void;
}

export function createTestDb(): TestDb {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Run all migrations in order
  const migrationsDir = path.join(__dirname, '..', 'migrations', 'sqlite');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    sqlite.exec(sql);
  }

  // Seed a test tenant
  sqlite.prepare(`INSERT INTO tenants (id, name, slug) VALUES ('test-tenant', 'Test', 'test')`).run();

  return {
    async run(sql: string, params?: unknown[]) { return sqlite.prepare(sql).run(...(params || [])); },
    async get<T>(sql: string, params?: unknown[]) { return sqlite.prepare(sql).get(...(params || [])) as T; },
    async query<T>(sql: string, params?: unknown[]) { return sqlite.prepare(sql).all(...(params || [])) as T[]; },
    close() { sqlite.close(); },
  };
}
