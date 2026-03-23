export interface DatabaseAdapter {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  transaction<T>(fn: () => T | Promise<T>): Promise<T>;
  pragma(statement: string): unknown;
  close(): void;
  backup(path: string): void | Promise<void>;
}

export { SQLiteAdapter } from './sqlite.js';
export { runMigrations } from './migrate.js';
export { seedDatabase } from './seed.js';
export { migrateV1Data } from './migrate-v1.js';

import { SQLiteAdapter } from './sqlite.js';

export function createDatabase(dbPath: string): DatabaseAdapter {
  return new SQLiteAdapter(dbPath);
}
