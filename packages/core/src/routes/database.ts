/**
 * Database management routes — status, migration.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../auth/middleware.js';
import { getDb, getConfig } from './utils.js';

// Tables to migrate in FK-safe order
const MIGRATE_TABLES = [
  'tenants', 'users', 'sessions', 'messages', 'tool_calls',
  'usage_records', 'audit_log', 'tool_permissions', 'memory_chunks', 'pending_senders',
];

export const registerDatabaseRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/v1/admin/database — database status + migration info
  app.get('/api/v1/admin/database', { preHandler: [requireRole('admin')] }, async (request) => {
    const config = getConfig(request);
    const db = getDb(request);
    const stateDir = config._stateDir || '';

    const isPostgres = !!process.env.AGW_DATABASE_URL;
    const sqliteDbPath = path.join(stateDir, 'gateway.db');
    const sqliteExists = fs.existsSync(sqliteDbPath);
    const sqliteMigratedPath = sqliteDbPath + '.migrated';
    const sqliteMigrated = fs.existsSync(sqliteMigratedPath);

    // Get current DB row counts
    const counts: Record<string, number> = {};
    for (const table of MIGRATE_TABLES) {
      try {
        const row = await db.get<{ c: number }>(`SELECT COUNT(*) as c FROM ${table}`);
        counts[table] = row?.c ?? 0;
      } catch { counts[table] = 0; }
    }

    // Check SQLite data available for migration
    let sqliteCounts: Record<string, number> | null = null;
    let sqliteSize: number | null = null;
    if (isPostgres && sqliteExists) {
      try {
        const stat = fs.statSync(sqliteDbPath);
        sqliteSize = stat.size;

        // Open SQLite read-only to count rows
        const { createRequire } = await import('node:module');
        const { fileURLToPath } = await import('node:url');
        const { dirname, join } = await import('node:path');
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const req = createRequire(join(__dirname, '..', '..', 'package.json'));
        const Database = req('better-sqlite3');
        const sqliteDb = new Database(sqliteDbPath, { readonly: true });
        sqliteCounts = {};
        for (const table of MIGRATE_TABLES) {
          try {
            const row = sqliteDb.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
            sqliteCounts[table] = row?.c ?? 0;
          } catch { sqliteCounts[table] = 0; }
        }
        sqliteDb.close();
      } catch { /* SQLite not readable */ }
    }

    return {
      type: isPostgres ? 'postgres' : 'sqlite',
      url: isPostgres ? process.env.AGW_DATABASE_URL?.replace(/:[^:@]+@/, ':***@') : undefined,
      counts,
      migration: isPostgres ? {
        available: sqliteExists && !sqliteMigrated,
        alreadyMigrated: sqliteMigrated,
        sqlitePath: sqliteExists ? sqliteDbPath : null,
        sqliteSize,
        sqliteCounts,
      } : null,
    };
  });

  // POST /api/v1/admin/database/migrate — migrate SQLite → PostgreSQL
  app.post('/api/v1/admin/database/migrate', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const config = getConfig(request);
    const db = getDb(request);
    const stateDir = config._stateDir || '';

    if (!process.env.AGW_DATABASE_URL) {
      return reply.code(400).send({ error: 'AGW_DATABASE_URL not set — cannot migrate to PostgreSQL' });
    }

    const sqliteDbPath = path.join(stateDir, 'gateway.db');
    if (!fs.existsSync(sqliteDbPath)) {
      return reply.code(400).send({ error: 'No SQLite database found to migrate' });
    }

    if (fs.existsSync(sqliteDbPath + '.migrated')) {
      return reply.code(400).send({ error: 'Migration already completed' });
    }

    try {
      // Open SQLite read-only
      const { createRequire } = await import('node:module');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const req = createRequire(join(__dirname, '..', '..', 'package.json'));
      const Database = req('better-sqlite3');
      const sqliteDb = new Database(sqliteDbPath, { readonly: true });

      const migrated: Record<string, number> = {};

      // Disable FK checks during migration
      try { await db.run('SET session_replication_role = replica'); } catch { /* SQLite ignores */ }

      for (const table of MIGRATE_TABLES) {
        // Check table exists in SQLite
        const exists = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if (!exists) { migrated[table] = 0; continue; }

        const rows = sqliteDb.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
        if (rows.length === 0) { migrated[table] = 0; continue; }

        const columns = Object.keys(rows[0]);

        // Clear existing PG data
        await db.run(`DELETE FROM ${table}`);

        // Insert rows
        for (const row of rows) {
          const values = columns.map(c => row[c]);
          const placeholders = columns.map(() => '?').join(', ');
          await db.run(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
            values as unknown[],
          );
        }

        migrated[table] = rows.length;

        // Reset serial sequences
        if (['messages', 'usage_records', 'audit_log', 'tool_permissions', 'memory_chunks', 'pending_senders'].includes(table)) {
          try {
            await db.run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
          } catch { /* sequence may not exist */ }
        }
      }

      // Re-enable FK checks
      try { await db.run('SET session_replication_role = DEFAULT'); } catch { /* ignore */ }

      sqliteDb.close();

      // Rename gateway.db → gateway.db.migrated (backup)
      fs.renameSync(sqliteDbPath, sqliteDbPath + '.migrated');

      return {
        success: true,
        migrated,
        message: 'Migration complete. SQLite database backed up as gateway.db.migrated.',
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ error: `Migration failed: ${msg}` });
    }
  });
};
