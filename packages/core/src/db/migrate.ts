import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseAdapter } from './index.js';

interface MigrationRecord {
  version: number;
  name: string;
}

async function ensureMigrationsTable(db: DatabaseAdapter): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

async function getAppliedVersions(db: DatabaseAdapter): Promise<Set<number>> {
  const rows = await db.query<MigrationRecord>('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

interface MigrationFile {
  version: number;
  name: string;
  path: string;
}

function discoverMigrations(migrationsDir: string): MigrationFile[] {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  const migrations: MigrationFile[] = [];

  for (const file of files) {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) continue;

    migrations.push({
      version: parseInt(match[1], 10),
      name: match[2],
      path: join(migrationsDir, file),
    });
  }

  return migrations.sort((a, b) => a.version - b.version);
}

export async function runMigrations(db: DatabaseAdapter, migrationsDir: string): Promise<void> {
  await ensureMigrationsTable(db);
  const applied = await getAppliedVersions(db);
  const migrations = discoverMigrations(migrationsDir);

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    const sql = readFileSync(migration.path, 'utf8');

    // Strip SQL comments before splitting into statements
    const cleanSql = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const statements = cleanSql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Extract PRAGMA statements (must run outside transactions)
    const pragmas = statements.filter((s) => /^PRAGMA\s/i.test(s));
    const nonPragmas = statements.filter((s) => !/^PRAGMA\s/i.test(s));

    const disablesFK = pragmas.some((p) => /foreign_keys\s*=\s*OFF/i.test(p));

    if (disablesFK) {
      // FK-sensitive migration: run ALL statements outside transaction
      // (PRAGMA foreign_keys cannot be toggled inside a transaction)
      db.pragma('foreign_keys = OFF');
      for (const stmt of nonPragmas) {
        await db.run(stmt);
      }
      await db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
        migration.version,
        migration.name,
      ]);
      db.pragma('foreign_keys = ON');
    } else {
      // Normal migration: run PRAGMAs outside, then statements inside transaction
      for (const pragma of pragmas) {
        const pragmaBody = pragma.replace(/^PRAGMA\s+/i, '');
        db.pragma(pragmaBody);
      }
      await db.transaction(async () => {
        for (const stmt of nonPragmas) {
          await db.run(stmt);
        }
        await db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
          migration.version,
          migration.name,
        ]);
      });
    }
  }
}
