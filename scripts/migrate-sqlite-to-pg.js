#!/usr/bin/env node
/**
 * Migrate data from SQLite (gateway.db) to PostgreSQL.
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-pg.js <sqlite-path> <postgres-url>
 *
 * Example:
 *   node scripts/migrate-sqlite-to-pg.js ./local_data/agw-data/gateway.db postgres://kairo:kairo_dev_pass@localhost:15432/kairoclaw
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const coreRequire = createRequire(join(__dirname, '..', 'packages', 'core', 'package.json'));
const Database = coreRequire('better-sqlite3');
const pg = coreRequire('pg');

const { Pool } = pg;

const SQLITE_PATH = process.argv[2];
const PG_URL = process.argv[3];

if (!SQLITE_PATH || !PG_URL) {
  console.error('Usage: node scripts/migrate-sqlite-to-pg.js <sqlite-path> <postgres-url>');
  process.exit(1);
}

// Tables to migrate in order (respects FK dependencies)
const TABLES = [
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
  'cron_jobs',
];

async function migrate() {
  console.log('Opening SQLite:', SQLITE_PATH);
  const sqlite = new Database(SQLITE_PATH, { readonly: true });

  console.log('Connecting to PostgreSQL:', PG_URL.replace(/:[^:@]+@/, ':***@'));
  const pool = new Pool({ connectionString: PG_URL });

  try {
    // Disable FK checks during migration (orphaned data may exist in SQLite)
    await pool.query('SET session_replication_role = replica');

    for (const table of TABLES) {
      // Check if table exists in SQLite
      const tableExists = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table);
      if (!tableExists) {
        console.log(`  ${table}: skipped (not in SQLite)`);
        continue;
      }

      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      if (rows.length === 0) {
        console.log(`  ${table}: 0 rows (empty)`);
        continue;
      }

      // Get column names from first row
      const columns = Object.keys(rows[0]);

      // Clear existing PG data for this table (in case of re-run)
      await pool.query(`DELETE FROM ${table}`);

      // Insert in batches
      const BATCH_SIZE = 100;
      let inserted = 0;

      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const row of batch) {
            const values = columns.map(c => row[c]);
            const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');
            await client.query(
              `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
              values,
            );
            inserted++;
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      }

      console.log(`  ${table}: ${inserted} rows migrated`);

      // Reset serial sequences for tables with SERIAL columns
      if (['messages', 'usage_records', 'audit_log', 'tool_permissions', 'memory_chunks', 'pending_senders', 'sender_links'].includes(table)) {
        try {
          await pool.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
        } catch { /* sequence may not exist */ }
      }
    }

    // Also migrate schema_migrations so PG knows which migrations ran
    const migrations = sqlite.prepare('SELECT * FROM schema_migrations').all();
    if (migrations.length > 0) {
      await pool.query('DELETE FROM schema_migrations');
      for (const m of migrations) {
        await pool.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [m.version, m.name, m.applied_at],
        );
      }
      console.log(`  schema_migrations: ${migrations.length} rows migrated`);
    }

    // Re-enable FK checks
    await pool.query('SET session_replication_role = DEFAULT');

    console.log('\nMigration complete!');
  } finally {
    sqlite.close();
    await pool.end();
  }
}

migrate().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
