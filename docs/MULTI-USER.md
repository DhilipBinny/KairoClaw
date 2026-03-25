# Multi-User System

KairoClaw supports multiple users within a single deployment. Each user gets their own sessions, permissions, usage tracking, and channel identity — while sharing the same AI configuration, API keys, and channels.

---

## Architecture Overview

```
KairoClaw Instance (single org)
│
├── Admin (you)
│   ├── Full access to all tools, config, user management
│   ├── Linked: Telegram ID 12345, WhatsApp +6512345
│   └── Sessions: telegram:12345, whatsapp:6512345, web:xxx
│
├── User: Manoj
│   ├── Safe tools only (no exec, no cron)
│   ├── Linked: Telegram ID 67890, WhatsApp +6567890
│   └── Sessions: telegram:67890, whatsapp:6567890
│
├── User: Mom (elevated)
│   ├── All tools (elevated flag granted by admin)
│   ├── Linked: WhatsApp +6511111
│   └── Sessions: whatsapp:6511111
│
├── Shared Resources:
│   ├── One Telegram bot (all users message the same bot)
│   ├── One WhatsApp number (all users message the same number)
│   ├── One set of API keys (Anthropic, OpenAI, Ollama)
│   ├── One system prompt / AI personality
│   └── MCP servers, plugins, cron jobs
```

---

## User Roles

| Role | Config | Tools | Sessions | User Mgmt |
|------|--------|-------|----------|-----------|
| **admin** | Full access | All tools | See all | Manage all users |
| **user** | Read-only | Safe tools only | Own only | None |
| **user + elevated** | Read-only | All tools | Own only | None |

### Dangerous Tools (require admin or elevated)

- `exec` — shell command execution
- `manage_cron` — create/edit/delete scheduled jobs
- `write_file` — write files to workspace
- `delete_file` — delete workspace files

All other tools (web_search, read_file, memory, media, etc.) are available to all users.

### Elevated Toggle

Admin can grant the "elevated" flag to specific users, giving them access to dangerous tools without making them admin. Useful for tech-savvy friends who need exec but shouldn't manage config.

---

## Sender Linking

Sender linking maps channel identities (Telegram user ID, WhatsApp phone number) to KairoClaw user accounts. This is how the system knows "Telegram user 67890 = Manoj."

### How It Works

```
Telegram message arrives
        │
        ▼
Extract sender_id (e.g., "67890")
        │
        ▼
Lookup sender_links table:
  WHERE channel_type = 'telegram' AND sender_id = '67890'
        │
        ├── FOUND → user_id = "usr_manoj"
        │     │
        │     ▼
        │   Load user: Manoj, role=user, elevated=false
        │     │
        │     ▼
        │   Create session with user_id = "usr_manoj"
        │   Apply tool permissions (safe tools only)
        │   Track usage under Manoj's account
        │
        └── NOT FOUND → session created with user_id = NULL
              │
              ▼
            Sender appears in pending_senders queue
            Admin can onboard or link later
```

### Unified Identity

One user can be linked to multiple channels:

```
User: Manoj
  ├── sender_link: telegram → 67890
  ├── sender_link: whatsapp → 971501234567
  └── webchat: authenticated via API key

All sessions from all channels → same user_id → same permissions
```

### Schema

```sql
sender_links (
  id            SERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  channel_type  TEXT NOT NULL,          -- 'telegram', 'whatsapp'
  sender_id     TEXT NOT NULL,          -- Telegram user ID, phone number
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at     TEXT NOT NULL,
  linked_by     TEXT REFERENCES users(id),  -- admin who linked
  UNIQUE(tenant_id, channel_type, sender_id)
)
```

---

## User Onboarding

### Flow: New Person Messages the Bot

```
1. Unknown person messages Telegram/WhatsApp bot
   └── Not in allowFrom → message rejected
   └── Added to pending_senders queue

2. Admin sees pending sender in /admin/channels
   └── Three options:
       ├── [Onboard]       → Create user + link + approve (recommended)
       ├── [Approve Only]  → Add to allowFrom, no user account
       └── [Dismiss]       → Reject

3. Admin clicks "Onboard":
   ┌──────────────────────────────────────┐
   │  Onboard New User                    │
   │                                      │
   │  [Telegram] John Smith (12345)       │
   │                                      │
   │  [Create New User] [Link to Existing]│
   │                                      │
   │  Name: [John Smith]  ← pre-filled    │
   │  Email: [          ]                 │
   │  Role:  [User ▾]                    │
   │  Elevated: [ ]                       │
   │                                      │
   │  [Cancel]  [Create & Approve]        │
   └──────────────────────────────────────┘

4. One click does ALL of this:
   ✓ Creates user account
   ✓ Generates API key (shown once — for webchat access)
   ✓ Creates sender_link (Telegram ID → user)
   ✓ Adds sender to allowFrom config
   ✓ Marks pending sender as approved
   ✓ Backfills existing sessions with user_id

5. Next message from John → fully attributed, permissions applied
```

### Flow: Same Person on Second Channel

```
1. Manoj already onboarded via Telegram
2. Manoj messages WhatsApp bot → new pending sender

3. Admin clicks "Onboard" on WhatsApp sender:
   ┌──────────────────────────────────────┐
   │  [Create New User] [Link to Existing]│
   │                                      │
   │  Select User:                        │
   │  [Manoj (telegram:67890)     ▾]      │
   │                                      │
   │  [Cancel]  [Link & Approve]          │
   └──────────────────────────────────────┘

4. Links WhatsApp number to existing Manoj account
   → Both channels now resolve to same user
```

---

## User Management

### Admin UI: /admin/users

```
┌─────────────────────────────────────────────────────────────┐
│ Users                                    [+ Add User]       │
│                                                             │
│ Name    │ Role         │ Status │ Links        │ Actions    │
│─────────│──────────────│────────│──────────────│────────────│
│ Binny   │ admin        │ Active │ tg:12345     │ Edit Key   │
│         │              │        │ wa:+6512345  │            │
│ Manoj   │ user         │ Active │ tg:67890     │ Edit Key   │
│         │              │        │ wa:+6567890  │ Link Deact │
│ Mom     │ user elevated│ Active │ wa:+6511111  │ Edit Key   │
│         │              │        │              │ Link Deact │
│ OldUser │ user         │ Deact  │ (none)       │ React Del  │
└─────────────────────────────────────────────────────────────┘
```

### Creating a User

1. Click "+ Add User"
2. Fill: name, email (optional), role, elevated toggle
3. Click "Create User"
4. API key shown **once** — copy it now
5. Give the API key to the user (for webchat login)

### Regenerating API Keys

Regeneration requires typing "REGENERATE" to prevent accidental invalidation:

```
┌──────────────────────────────────────────┐
│  Regenerate API Key                      │
│                                          │
│  ⚠ The current API key for Manoj will   │
│  be permanently invalidated. The user    │
│  will be locked out until they receive   │
│  the new key.                            │
│                                          │
│  Type REGENERATE to confirm:             │
│  [                    ]                  │
│                                          │
│  [Cancel]  [Regenerate Key] (disabled)   │
└──────────────────────────────────────────┘
```

### Deactivation vs Deletion

| Action | Reversible | Sessions | Sender Links | Audit Log |
|--------|-----------|----------|-------------|-----------|
| **Deactivate** | Yes (reactivate) | Preserved | Removed | Preserved |
| **Permanently Delete** | No | Nullified (user_id set to NULL) | Deleted | Preserved |

**Deactivation:** User can't log in (API key rejected with 403), can't message via channels (sender links removed). Sessions preserved for audit. Admin can reactivate anytime.

**Permanent deletion:** User record deleted, sessions remain but with `user_id = NULL`. Usage records deleted. Audit log entries preserved (hash chain integrity).

---

## Session Isolation

- **Admin** sees all sessions across all users
- **Non-admin users** see only their own sessions (filtered by `user_id`)
- Sessions list includes user name column for admin view
- Each session shows which user owns it

### How Sessions Get User Attribution

| Channel | How user_id is set |
|---------|-------------------|
| Webchat | From authenticated API key (direct user.id) |
| REST API | From authenticated API key (direct user.id) |
| Telegram | Via sender_links lookup (sender_id → user.id) |
| WhatsApp | Via sender_links lookup (sender_id → user.id) |

If no sender_link exists for a channel sender, session gets `user_id = NULL` (unowned). Once admin links the sender, existing sessions are **backfilled** retroactively.

---

## Usage Tracking

Usage is tracked per-user automatically:

- Every LLM call records: `user_id`, model, tokens, cost
- Admin can view per-user usage breakdown via `/admin/usage?groupBy=user`
- Health endpoint returns total user count and active user count

### Future: Per-User Token Limits

Schema is ready (`token_limit` column) but enforcement is deferred. When enabled:
- Admin sets monthly token cap per user
- Agent checks limit before each LLM call
- Friendly message when limit reached: "Usage limit reached for this month"

---

## API Endpoints

### User Management (admin only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/admin/users` | List all users with stats |
| POST | `/api/v1/admin/users` | Create user (returns API key once) |
| GET | `/api/v1/admin/users/:id` | User detail + links + usage |
| PATCH | `/api/v1/admin/users/:id` | Update name/email/role/elevated |
| DELETE | `/api/v1/admin/users/:id` | Deactivate (soft delete) |
| DELETE | `/api/v1/admin/users/:id/permanent` | Hard delete |
| POST | `/api/v1/admin/users/:id/reactivate` | Reactivate |
| POST | `/api/v1/admin/users/:id/api-key` | Regenerate API key |

### Sender Links (admin only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/admin/users/:id/sender-links` | List linked senders |
| POST | `/api/v1/admin/users/:id/sender-links` | Link a sender |
| DELETE | `/api/v1/admin/users/:id/sender-links/:linkId` | Unlink |

### Onboarding (admin only)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/admin/channels/pending-senders/:id/onboard` | Create user + approve + link in one step |
| POST | `/api/v1/admin/channels/pending-senders/:id/approve` | Approve only (optional userId to link) |

---

## Migration from Single-User

When deploying this update to an existing instance:

1. **Migration runs automatically** — `008_multi_user.sql` adds `sender_links` table and new user columns
2. **Existing admin works as before** — admin role bypasses all new permission checks
3. **Existing sessions stay as-is** — `user_id = NULL` for channel sessions (unlinked)
4. **allowFrom still works** — backward compatible, sender_links is an additional layer

### To set up existing users:

```
1. Go to /admin/users → "Add User" for each person
2. For each user, click "Link" → enter their Telegram ID or WhatsApp number
3. Existing sessions from that sender get backfilled with user_id
4. Future messages automatically resolve to the linked user
```

Or use the onboarding flow from `/admin/channels` if they appear in pending senders.

---

## Security

### Tenant Isolation
All sender_links queries enforce `tenant_id`. No cross-tenant data leakage.

### Auth Middleware
- Deactivated users get 403 on any API request
- Elevated flag loaded from DB on each request (not cached)

### Tool Permissions
- Dangerous tools hardcoded (not configurable — prevents bypass)
- Admin always bypasses permission checks
- Elevated check happens before DB rule check

### API Key Security
- Keys stored as SHA-256 hash (irreversible)
- Keys shown only once on creation/regeneration
- Regeneration requires typed confirmation ("REGENERATE")
- Old key immediately invalidated on regeneration

### Audit Trail
- User creation/deletion logged in audit_log
- Tool denials logged (tool.denied action)
- All admin actions logged with user_id and IP
