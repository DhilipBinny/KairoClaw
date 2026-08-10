# Database Configuration

KairoClaw supports two database backends: **SQLite** (default) and **PostgreSQL** (enterprise).

## Quick Start

### SQLite (default — zero config)

Just start KairoClaw. A `gateway.db` file is created automatically in the state directory.

### PostgreSQL

Set one environment variable:

```bash
AGW_DATABASE_URL=postgres://user:password@host:5432/kairoclaw
```

That's it. On first start, tables are created and data is seeded.

---

## Database Comparison

| Feature | SQLite | PostgreSQL |
|---------|--------|------------|
| Setup | Zero config | Set `AGW_DATABASE_URL` |
| Concurrency | Single writer, ~4 concurrent agents | Full concurrent access |
| Scale | <20 users, single server | 100+ users, multi-server |
| Encryption at rest | Not encrypted (future: SQLCipher) | Native TDE / disk encryption |
| Backup | Daily automated (native `backup()` API) | Daily automated (`pg_dump` with `PGPASSWORD`) |
| Data location | `{stateDir}/gateway.db` | External PostgreSQL server |
| Recommended for | Personal, small team | Enterprise, production |

## What's Stored Where

| Data | Location | Affected by DB switch? |
|------|----------|----------------------|
| Sessions, messages | Database | Yes — migrated automatically |
| Audit log | Database | Yes — migrated automatically |
| Usage records | Database | Yes — migrated automatically |
| Tool permissions | Database | Yes — migrated automatically |
| Background tasks | Database | Yes — migrated automatically |
| Alert history | Database | Yes — migrated automatically |
| API keys (hashed) | Database | Yes — migrated automatically |
| Config | `config.json` (filesystem) | No |
| Secrets (API tokens) | `secrets.enc` (filesystem) | No |
| Workspace files | `workspace/` (filesystem) | No |
| Master encryption key | `master.key` (filesystem) | No |
| Plugins | `plugins.json` (filesystem) | No |
| Cron jobs | Database | Yes — migrated automatically (legacy: `cron-jobs.json` is the migration source) |

---

## Migration: SQLite → PostgreSQL

### Automatic (recommended)

When you switch to PostgreSQL, data migrates automatically on first startup:

1. Set `AGW_DATABASE_URL` and restart
2. App creates PostgreSQL tables (schema migration)
3. App detects: PG is empty + `gateway.db` exists
4. **Auto-migrates all data** (sessions, messages, users, audit, etc.)
5. Renames `gateway.db` → `gateway.db.migrated` (backup)
6. Seed is skipped (data came from migration)
7. Your existing admin API key works immediately

**No action needed** — just set the env var and restart.

### What gets migrated

| Table | Description |
|-------|------------|
| tenants | Multi-tenant organizations |
| users | Admin and user accounts (with API key hashes, roles, elevated flag) |
| sessions | Chat sessions (web, telegram, whatsapp, etc.) |
| messages | Conversation history |
| tool_calls | Tool execution audit trail |
| usage_records | Token usage and cost tracking |
| audit_log | Tamper-evident audit chain |
| tool_permissions | RBAC rules |
| memory_chunks | Workspace memory index |
| pending_senders | Channel discovery records |
| sender_links | Maps Telegram/WhatsApp sender IDs to user accounts |
| cron_jobs | Scheduled tasks with per-user ownership |
| background_tasks | Durable background task state (survives restarts) |
| alert_history | Alert firing/resolution history (30-day retention) |

### Conditions for auto-migration

All must be true:
- `AGW_DATABASE_URL` is set (PostgreSQL mode)
- `gateway.db` exists in state directory
- `gateway.db.migrated` does NOT exist (not already migrated)
- PostgreSQL tenants table is empty (fresh PG database)

### Manual migration (fallback)

If auto-migration didn't trigger, use the admin UI:

1. Open `/admin/database` in the browser
2. The page shows SQLite data available for migration
3. Click "Migrate Now"

Or use the CLI script:

```bash
node scripts/migrate-sqlite-to-pg.js ./path/to/gateway.db postgres://user:pass@host:5432/kairoclaw
```

---

## Edge Cases & Constraints

### Migration failed midway
- `gateway.db` is NOT renamed (preserved for retry)
- PostgreSQL may have partial data
- Next restart will retry: clears partial PG data, re-migrates from SQLite

### Want to re-migrate
- `gateway.db.migrated` exists → auto-migration won't run
- To re-trigger: rename `gateway.db.migrated` back to `gateway.db`
- Ensure PG tenants table is empty (or clear all PG data)

### Orphaned data in SQLite
- Some messages may reference deleted sessions (FK violations)
- Migration disables FK checks during import (`SET session_replication_role = replica`)
- Data is imported as-is, orphaned rows included

### Audit log hash chain
- Chain is preserved as-is from SQLite
- If concurrent PG requests caused duplicates before the FOR UPDATE fix,
  the chain may show `brokenAt` for old entries
- New entries after migration maintain correct chain integrity

### PostgreSQL connection validation
- On startup, the app validates the PG connection BEFORE any migration
- If the connection fails (wrong URL, wrong credentials, PG not running):
  - Clear error message: `POSTGRESQL CONNECTION FAILED: <reason>`
  - Shows masked connection string for debugging
  - App exits cleanly (exit code 1)
  - `gateway.db` is NEVER touched — safe to fix the URL and retry
- Connection is validated with a simple `SELECT 1` query

### PostgreSQL connection requirements
- Minimum PostgreSQL 13 (tested on 17)
- User needs CREATE TABLE, INSERT, UPDATE, DELETE permissions
- Connection pooling: 2-10 connections (configurable)

### What happens to gateway.db after migration
- Renamed to `gateway.db.migrated` (not deleted)
- Safe to delete after verifying PG data is correct
- SQLite WAL files (`.db-shm`, `.db-wal`) may remain — safe to delete

### Switching back to SQLite
- Remove `AGW_DATABASE_URL` env var and restart
- Rename `gateway.db.migrated` back to `gateway.db`
- App uses SQLite again (PG data is NOT migrated back)

---

## Admin UI: Database Page

Located at `/admin/database`. Shows:

- **Current database type** (SQLite or PostgreSQL)
- **Connection string** (masked password)
- **Row counts** per table
- **Migration status** (available, completed, or N/A)
- **Manual migrate button** (fallback if auto-migration didn't run)
- **SQLite setup instructions** (when not using PG)

---

## Docker Compose Example

```yaml
services:
  kairoclaw:
    image: kairoclaw:latest
    ports:
      - "18181:18181"
    environment:
      AGW_STATE_DIR: /data
      AGW_DATABASE_URL: postgres://kairo:secret@db:5432/kairoclaw
      AGW_MASTER_KEY: <base64-encryption-key>
    volumes:
      - kairoclaw-data:/data
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: kairoclaw
      POSTGRES_USER: kairo
      POSTGRES_PASSWORD: secret
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: pg_isready -U kairo -d kairoclaw
      interval: 5s
      retries: 5

volumes:
  kairoclaw-data:
  postgres-data:
```

---

## Daily Automated Backups

KairoClaw runs automated daily database backups for both SQLite and PostgreSQL.

### How it works

| | SQLite | PostgreSQL |
|--|--------|------------|
| **Method** | Native `better-sqlite3` `backup()` API | `pg_dump --format=custom` via `PGPASSWORD` env |
| **File pattern** | `gateway.db.backup-YYYY-MM-DD` | `gateway.pg.backup-YYYY-MM-DD.dump` |
| **Location** | State directory (`AGW_STATE_DIR`) | State directory (`AGW_STATE_DIR`) |
| **Retention** | 7 days (oldest auto-deleted) | 7 days (oldest auto-deleted) |
| **Schedule** | Every 24 hours + 30s after startup | Every 24 hours + 30s after startup |
| **Timeout** | N/A (in-process) | 120 seconds |

### Backup retention

- The 7 most recent backups are kept; older files are automatically deleted
- Retention count is controlled by `SQLITE_BACKUP_RETENTION` in `core/src/constants.ts`
- One backup per calendar day (skips if today's backup file already exists)

### PostgreSQL prerequisites

- `pg_dump` must be installed on the host (package: `postgresql-client`)
- If `pg_dump` is not found, a warning is logged and backups are silently skipped (no crash)
- Password is passed via `PGPASSWORD` environment variable (not command-line args) for security

### Restore from backup

**SQLite:**
```bash
cp gateway.db.backup-2026-06-15 gateway.db
```

**PostgreSQL:**
```bash
pg_restore --clean --dbname=postgres://user:pass@host:5432/kairoclaw gateway.pg.backup-2026-06-15.dump
```

### Failure alerting

If a backup fails (for reasons other than missing `pg_dump`), a `system.backup_failed` alert is fired with severity `warning`. Alerts are delivered through the configured alert channels (WhatsApp, Telegram, etc.).

---

## Schema Details

### Migrations

There are **16 SQLite migrations** and **10 PostgreSQL migrations**. PostgreSQL has fewer because the initial schema (001) covers what SQLite builds up across migrations 001-009.

| # | SQLite | PostgreSQL | Description |
|---|--------|------------|-------------|
| 001 | `001_initial_schema.sql` | `001_initial_schema.sql` | Base tables (tenants, users, sessions, messages, tool_calls, usage_records, audit_log) |
| 002 | `002_memory_chunks.sql` | `002_multi_user.sql` | SQLite: memory chunks table; PG: multi-user support |
| 003 | `003_fix_session_channel_constraint.sql` | `003_tool_permission_power_user.sql` | SQLite: session channel fix; PG: power user permissions |
| 004 | `004_mcp_status_message.sql` | `004_cron_jobs.sql` | SQLite: MCP status; PG: cron jobs table |
| 005 | `005_fix_audit_log_fk.sql` | `005_browse_permission.sql` | SQLite: audit FK fix; PG: browse permission |
| 006 | `006_pending_senders.sql` | — | Pending senders table |
| 007 | `007_drop_mcp_servers_table.sql` | — | Drop legacy MCP servers table |
| 008 | `008_multi_user.sql` | — | Multi-user support |
| 009 | `009_tool_permission_power_user.sql` | — | Power user permissions |
| 010 | `010_cron_jobs.sql` | — | Cron jobs table |
| 011 | `011_browse_permission.sql` | — | Browse tool permission |
| 012 | `012_background_tasks.sql` | `012_background_tasks.sql` | Durable background task registry |
| 013 | `013_missing_indexes.sql` | `013_missing_indexes.sql` | Performance indexes |
| 014 | `014_sandbox_exec_permission.sql` | `014_sandbox_exec_permission.sql` | Sandbox exec permission |
| 015 | `015_thinking_blocks.sql` | `015_thinking_blocks.sql` | Add `thinking_blocks` column to messages table |
| 016 | `016_alert_history.sql` | `016_alert_history.sql` | Alert history table |

### Notable columns added by later migrations

- **`messages.thinking_blocks`** (migration 015) — JSON text storing LLM extended thinking blocks for persistence and replay
- **`background_tasks.*`** (migration 012) — full task lifecycle: id, session_id, scope_key, task, status, timestamps, result/error
- **`alert_history.*`** (migration 016) — alert fingerprint, type, severity, state, title, message, labels, fired/resolved timestamps

---

## Troubleshooting

### "POSTGRESQL CONNECTION FAILED"
- Check that PostgreSQL is running and accessible
- Verify `AGW_DATABASE_URL` format: `postgres://user:password@host:port/database`
- If using Docker Compose, ensure `depends_on` with `service_healthy` condition
- `gateway.db` is safe — not touched when connection fails

### Migration didn't run
- Check all 4 conditions: `AGW_DATABASE_URL` set, `gateway.db` exists, no `.migrated` file, PG tenants empty
- Check logs for `[db] Auto-migrating` or `[db] Migration complete`
- If `.migrated` exists from a previous attempt, rename it back to `.db` to retry

### Old admin key doesn't work after switching to PG
- If auto-migration ran: old key should work (user table migrated)
- If PG was already seeded (had data): migration was skipped, new key was generated
- Fix: clear PG data, restore `gateway.db` from `.migrated`, restart

### Lost admin key after PG volume reset
- PG volume was deleted but `.migrated` exists → seed created new key
- The new key was printed in startup logs (check `docker logs`)
- To restore old data: rename `.migrated` → `.db`, delete PG volume, restart

### Migration completed but some data seems missing
- Sessions list filters out `internal` and `cron` sessions — check with direct PG query
- Verify with: `psql <url> -c "SELECT COUNT(*) FROM sessions"`
