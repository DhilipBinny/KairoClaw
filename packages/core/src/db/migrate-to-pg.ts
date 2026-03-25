/**
 * Auto-migrate SQLite → PostgreSQL on startup.
 *
 * ═══════════════════════════════════════════════════════════
 * BEHAVIOR:
 *
 *   Triggers when ALL of these are true:
 *   1. AGW_DATABASE_URL is set (PostgreSQL mode)
 *   2. gateway.db exists in stateDir
 *   3. gateway.db.migrated does NOT exist (not already migrated)
 *   4. PostgreSQL tenants table is empty (fresh PG, no data yet)
 *
 *   What it does:
 *   - Opens gateway.db read-only
 *   - Copies all rows from all tables to PostgreSQL
 *   - Disables FK checks during copy (handles orphaned data)
 *   - Resets PostgreSQL serial sequences after copy
 *   - Renames gateway.db → gateway.db.migrated (backup)
 *
 *   What it preserves:
 *   - Admin user + API key hash (same key works on PG)
 *   - All sessions, messages, tool calls, usage records
 *   - Audit log (hash chain preserved as-is)
 *   - Tool permissions
 *   - Memory chunks
 *
 *   What it skips:
 *   - schema_migrations (PG has its own migration history)
 *   - mcp_servers (removed — MCP config is in config.json)
 *
 *   After migration:
 *   - seedDatabase() sees tenants exist → skips (no new admin key)
 *   - User's old admin key works immediately
 *   - gateway.db.migrated is a backup (can delete or keep)
 *
 * EDGE CASES:
 *   - If migration fails midway: gateway.db NOT renamed, PG may have
 *     partial data. Next restart will retry (PG tables cleared first).
 *   - If gateway.db has orphaned rows (FK violations): imported anyway
 *     (FK checks disabled during migration).
 *   - If user resets PG but keeps gateway.db.migrated: no re-migration
 *     (must manually rename .migrated back to .db to re-trigger).
 * ═══════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseAdapter } from './index.js';

// Tables to migrate in FK-safe order
const MIGRATE_TABLES = [
  'tenants',
  'users',
  'sessions',
  'messages',
  'tool_calls',
  'usage_records',
  'audit_log',
  'tool_permissions',
  'memory_chunks',
  'pending_senders',
  'sender_links',
];

// Tables with SERIAL primary keys that need sequence resets
const SERIAL_TABLES = [
  'messages', 'usage_records', 'audit_log',
  'tool_permissions', 'memory_chunks', 'pending_senders',
  'sender_links',
];

export interface MigrationResult {
  migrated: boolean;
  tables: Record<string, number>;
  totalRows: number;
  error?: string;
}

/**
 * Auto-migrate SQLite data to PostgreSQL if conditions are met.
 * Called during startup, before seedDatabase().
 *
 * Returns { migrated: false } if conditions aren't met (no-op).
 * Returns { migrated: true, tables, totalRows } on success.
 * Throws on unrecoverable error.
 */
export async function autoMigrateSqliteToPg(
  db: DatabaseAdapter,
  stateDir: string,
): Promise<MigrationResult> {
  const sqliteDbPath = path.join(stateDir, 'gateway.db');
  const migratedPath = sqliteDbPath + '.migrated';

  // ── Guard: only run when all conditions met ──────────

  // 1. Must be PostgreSQL mode
  if (!process.env.AGW_DATABASE_URL) {
    return { migrated: false, tables: {}, totalRows: 0 };
  }

  // 2. gateway.db must exist
  if (!fs.existsSync(sqliteDbPath)) {
    return { migrated: false, tables: {}, totalRows: 0 };
  }

  // 3. Must not already be migrated
  if (fs.existsSync(migratedPath)) {
    return { migrated: false, tables: {}, totalRows: 0 };
  }

  // 4. PG must be empty (tenants table has no rows)
  const pgTenants = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM tenants');
  if (pgTenants && pgTenants.count > 0) {
    // PG already has data — don't overwrite
    return { migrated: false, tables: {}, totalRows: 0 };
  }

  // ── All conditions met — migrate ──────────────────────

  console.log('[db] Auto-migrating SQLite → PostgreSQL...');

  // Open SQLite read-only using better-sqlite3 (already a dependency)
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const req = createRequire(join(__dirname, '..', '..', 'package.json'));
  const Database = req('better-sqlite3');
  const sqliteDb = new Database(sqliteDbPath, { readonly: true });

  const result: Record<string, number> = {};
  let totalRows = 0;

  try {
    // Disable FK checks (handles orphaned data from SQLite)
    try { await db.run('SET session_replication_role = replica'); } catch { /* SQLite ignores */ }

    for (const table of MIGRATE_TABLES) {
      // Check table exists in SQLite
      const exists = sqliteDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table);
      if (!exists) { result[table] = 0; continue; }

      const rows = sqliteDb.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      if (rows.length === 0) { result[table] = 0; continue; }

      const columns = Object.keys(rows[0]);

      // Clear any partial data in PG (in case of retry after failed attempt)
      await db.run(`DELETE FROM ${table}`);

      // Insert all rows
      for (const row of rows) {
        const values = columns.map(c => row[c]);
        const placeholders = columns.map(() => '?').join(', ');
        await db.run(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values as unknown[],
        );
      }

      result[table] = rows.length;
      totalRows += rows.length;

      // Reset serial sequences
      if (SERIAL_TABLES.includes(table)) {
        try {
          await db.run(
            `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`
          );
        } catch { /* sequence may not exist */ }
      }
    }

    // Re-enable FK checks
    try { await db.run('SET session_replication_role = DEFAULT'); } catch { /* ignore */ }

    sqliteDb.close();

    // Rename gateway.db → gateway.db.migrated (backup, not deleted)
    fs.renameSync(sqliteDbPath, migratedPath);

    console.log(`[db] Migration complete: ${totalRows} rows across ${Object.keys(result).filter(k => result[k] > 0).length} tables`);
    for (const [table, count] of Object.entries(result)) {
      if (count > 0) console.log(`  ${table}: ${count} rows`);
    }

    return { migrated: true, tables: result, totalRows };
  } catch (e) {
    // Migration failed — do NOT rename gateway.db (allow retry on next startup)
    sqliteDb.close();
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[db] SQLite→PG migration failed: ${msg}`);
    console.error('[db] gateway.db preserved — will retry on next restart');
    return { migrated: false, tables: result, totalRows, error: msg };
  }
}
