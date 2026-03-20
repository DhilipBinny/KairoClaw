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

  query<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
    return this.db.prepare(sql).run(...params);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  pragma(statement: string): unknown {
    return this.db.pragma(statement);
  }

  close(): void {
    this.db.close();
  }

  backup(path: string): void {
    this.db.backup(path);
  }
}
