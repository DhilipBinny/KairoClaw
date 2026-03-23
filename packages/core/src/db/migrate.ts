import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseAdapter } from './index.js';

export type DbDialect = 'sqlite' | 'postgres';

interface MigrationRecord {
  version: number;
  name: string;
}

async function ensureMigrationsTable(db: DatabaseAdapter, dialect: DbDialect): Promise<void> {
  const defaultTs = dialect === 'postgres' ? "(NOW()::TEXT)" : "(datetime('now'))";
  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT ${defaultTs}
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
  if (!existsSync(migrationsDir)) return [];
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

/**
 * Run pending migrations.
 * @param db - Database adapter
 * @param migrationsBaseDir - Base directory containing sqlite/ and postgres/ subdirectories
 * @param dialect - Database dialect ('sqlite' or 'postgres')
 */
export async function runMigrations(
  db: DatabaseAdapter,
  migrationsBaseDir: string,
  dialect: DbDialect = 'sqlite',
): Promise<void> {
  // Auto-detect directory structure: check for dialect subdirectory
  const dialectDir = join(migrationsBaseDir, dialect);
  const migrationsDir = existsSync(dialectDir) ? dialectDir : migrationsBaseDir;

  await ensureMigrationsTable(db, dialect);
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

    if (dialect === 'sqlite') {
      // SQLite: handle PRAGMA statements specially
      const pragmas = statements.filter((s) => /^PRAGMA\s/i.test(s));
      const nonPragmas = statements.filter((s) => !/^PRAGMA\s/i.test(s));
      const disablesFK = pragmas.some((p) => /foreign_keys\s*=\s*OFF/i.test(p));

      if (disablesFK) {
        // FK-sensitive migration: run ALL statements outside transaction
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
    } else {
      // PostgreSQL: no PRAGMAs, just run statements in a transaction
      await db.transaction(async () => {
        for (const stmt of statements) {
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
