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
| Backup | File copy | `pg_dump` |
| Data location | `{stateDir}/gateway.db` | External PostgreSQL server |
| Recommended for | Personal, small team | Enterprise, production |

## What's Stored Where

| Data | Location | Affected by DB switch? |
|------|----------|----------------------|
| Sessions, messages | Database | Yes — migrated automatically |
| Audit log | Database | Yes — migrated automatically |
| Usage records | Database | Yes — migrated automatically |
| Tool permissions | Database | Yes — migrated automatically |
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
