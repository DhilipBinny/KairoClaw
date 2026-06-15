/**
 * PostgreSQL adapter for DatabaseAdapter interface.
 *
 * Uses node-postgres (pg) with connection pooling.
 * Converts ? placeholders to $1, $2, ... for PostgreSQL compatibility.
 * Transaction isolation via AsyncLocalStorage (thread-safe for concurrent requests).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { PoolConfig, PoolClient } from 'pg';
import type { DatabaseAdapter } from '@agw/types';

const { Pool } = pg;

/**
 * Convert ? placeholders to $1, $2, ... for PostgreSQL.
 * Only converts unquoted ? (skips inside single-quoted strings).
 */
function convertPlaceholders(sql: string): string {
  let index = 0;
  let inString = false;
  let result = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && sql[i - 1] !== '\\') {
      inString = !inString;
      result += ch;
    } else if (ch === '?' && !inString) {
      result += `$${++index}`;
    } else {
      result += ch;
    }
  }
  return result;
}

/** AsyncLocalStorage to hold transaction client per async context. */
const txStorage = new AsyncLocalStorage<PoolClient>();

export class PostgresAdapter implements DatabaseAdapter {
  private pool: pg.Pool;
  private connectionString: string;

  constructor(connectionString: string, poolConfig?: Partial<PoolConfig>) {
    this.connectionString = connectionString;
    this.pool = new Pool({
      connectionString,
      max: poolConfig?.max ?? 10,
      min: poolConfig?.min ?? 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ...poolConfig,
    });
  }

  private get queryable(): pg.Pool | PoolClient {
    return txStorage.getStore() ?? this.pool;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.queryable.query(convertPlaceholders(sql), params);
    return result.rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await this.queryable.query(convertPlaceholders(sql), params);
    return (result.rows[0] as T) ?? undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    const result = await this.queryable.query(convertPlaceholders(sql), params);
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: 0,
    };
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    // If already in a transaction (nested), just run the function
    if (txStorage.getStore()) {
      return await fn();
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStorage.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  pragma(_statement: string): unknown {
    return undefined;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async backup(outputPath: string): Promise<void> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    try {
      const connStr = this.connectionString;
      if (!connStr) {
        console.warn('[db] PostgreSQL backup: no connection string available');
        return;
      }
      await execFileAsync('pg_dump', ['--format=custom', '--file', outputPath, connStr], { timeout: 120_000 });
    } catch (e) {
      const msg = (e as Error).message || '';
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        console.warn('[db] PostgreSQL backup: pg_dump not found. Install postgresql-client for automated backups.');
      } else {
        throw e;
      }
    }
  }
}
