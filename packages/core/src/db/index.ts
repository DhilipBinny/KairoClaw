export interface DatabaseAdapter {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  transaction<T>(fn: () => T | Promise<T>): Promise<T>;
  pragma(statement: string): unknown;
  close(): void | Promise<void>;
  backup(path: string): void | Promise<void>;
}

export { SQLiteAdapter } from './sqlite.js';
export { PostgresAdapter } from './postgres.js';
export { runMigrations } from './migrate.js';
export { seedDatabase } from './seed.js';
export { migrateV1Data } from './migrate-v1.js';

import { SQLiteAdapter } from './sqlite.js';
import { PostgresAdapter } from './postgres.js';

export type DatabaseConfig =
  | { type: 'sqlite'; path: string }
  | { type: 'postgres'; url: string; pool?: { min?: number; max?: number } };

export function createDatabase(config: string | DatabaseConfig): DatabaseAdapter {
  // Backward compatible: string = SQLite path
  if (typeof config === 'string') {
    return new SQLiteAdapter(config);
  }
  if (config.type === 'postgres') {
    return new PostgresAdapter(config.url, config.pool);
  }
  return new SQLiteAdapter(config.path);
}
