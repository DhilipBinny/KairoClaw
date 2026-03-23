/**
 * PostgreSQL adapter for DatabaseAdapter interface.
 *
 * Uses node-postgres (pg) with connection pooling.
 * Converts ? placeholders to $1, $2, ... for PostgreSQL compatibility.
 */

import pg from 'pg';
import type { PoolConfig, PoolClient } from 'pg';
import type { DatabaseAdapter } from './index.js';

const { Pool } = pg;

/** Convert ? placeholders to $1, $2, ... for PostgreSQL. */
function convertPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

export class PostgresAdapter implements DatabaseAdapter {
  private pool: pg.Pool;
  /** When inside a transaction, queries go through this client instead of the pool. */
  private txClient: PoolClient | null = null;

  constructor(connectionString: string, poolConfig?: Partial<PoolConfig>) {
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
    return this.txClient ?? this.pool;
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
      // PostgreSQL doesn't have lastInsertRowid — return 0
      // Use RETURNING clause in queries that need the inserted ID
      lastInsertRowid: 0,
    };
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.txClient) {
      // Already in a transaction (nested) — just run the function
      return await fn();
    }

    const client = await this.pool.connect();
    this.txClient = client;
    try {
      await client.query('BEGIN');
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      this.txClient = null;
      client.release();
    }
  }

  pragma(_statement: string): unknown {
    // PostgreSQL doesn't use PRAGMAs — no-op
    return undefined;
  }

  close(): void {
    this.pool.end().catch(() => {});
  }

  async backup(_path: string): Promise<void> {
    console.warn('[db] PostgreSQL backup via pg_dump is not yet implemented. Use pg_dump manually.');
  }
}
