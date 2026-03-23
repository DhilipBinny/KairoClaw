import Database from 'better-sqlite3';
import type { DatabaseAdapter } from './index.js';

export class SQLiteAdapter implements DatabaseAdapter {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000');
    this.db.pragma('foreign_keys = ON');
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    return this.db.prepare(sql).run(...params);
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    // better-sqlite3 transactions are synchronous, but fn may be async
    // (all db calls resolve immediately for SQLite, so await is safe).
    // Use BEGIN/COMMIT/ROLLBACK manually to support async callbacks.
    this.db.prepare('BEGIN').run();
    try {
      const result = await fn();
      this.db.prepare('COMMIT').run();
      return result;
    } catch (e) {
      this.db.prepare('ROLLBACK').run();
      throw e;
    }
  }

  pragma(statement: string): unknown {
    return this.db.pragma(statement);
  }

  close(): void {
    this.db.close();
  }

  async backup(path: string): Promise<void> {
    await this.db.backup(path);
  }
}
