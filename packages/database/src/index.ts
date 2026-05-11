/**
 * @agw/database — SQLite + PostgreSQL adapters with migration runner.
 *
 * Implements the DatabaseAdapter interface from @agw/types.
 * Enterprise products use this directly instead of importing from @agw/core.
 */

export type { DatabaseAdapter } from '@agw/types';
export { SQLiteAdapter } from './sqlite.js';
export { PostgresAdapter } from './postgres.js';
export { runMigrations } from './migrate.js';
export type { DbDialect } from './migrate.js';

import { SQLiteAdapter } from './sqlite.js';
import { PostgresAdapter } from './postgres.js';
import type { DatabaseAdapter } from '@agw/types';

export type DatabaseConfig =
  | { type: 'sqlite'; path: string }
  | { type: 'postgres'; url: string; pool?: { min?: number; max?: number } };

export function createDatabase(config: string | DatabaseConfig): DatabaseAdapter {
  if (typeof config === 'string') {
    return new SQLiteAdapter(config);
  }
  if (config.type === 'postgres') {
    return new PostgresAdapter(config.url, config.pool);
  }
  return new SQLiteAdapter(config.path);
}
