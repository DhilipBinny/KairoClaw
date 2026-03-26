# Multi-User System

KairoClaw supports multiple users on a single deployment. Each user gets their own isolated workspace, memory, permissions, and channel identity — while sharing the same AI agent, persona, and infrastructure.

---

## Quick Start

### For the admin (you)

1. Deploy KairoClaw → you're the admin
2. Someone messages your bot on Telegram/WhatsApp → they appear in **Channels → Pending**
3. Click **"Add as User"** → creates their account, links their channel, gives them an API key
4. They can now chat on their channel AND the web UI with their own isolated experience

### For users

- Chat via Telegram, WhatsApp, or web — the bot knows who you are
- Your conversations, memory, and files are private to you
- You can view your sessions, usage, and cron jobs at `/my/`

---

## User Roles

| | Admin | Power User | User |
|---|---|---|---|
| **Chat with the bot** | Yes | Yes | Yes |
| **Admin dashboard** (`/admin`) | Full access | No | No |
| **User dashboard** (`/my`) | Redirects to /admin | Yes | Yes |
| **See all sessions** | Yes | Own only | Own only |
| **See all users** | Yes | No | No |
| **Configure channels** | Yes | No | No |
| **Configure providers/models** | Yes | No | No |
| **Install plugins/MCP** | Yes | No | No |
| **Tool permissions** | Full control | N/A | N/A |
| **Shell commands (exec)** | Unrestricted | Sandboxed | Denied |
| **Write/create files** | Unrestricted | Scoped | Denied |
| **Edit files** | Unrestricted | Scoped | Denied |
| **Manage cron jobs** | All crons | Own crons | Denied |
| **Manage plugins** | Yes | Denied | Denied |
| **Read files** | All | Own scope + shared | Own scope + shared |
| **Web search/fetch** | Yes | Yes | Yes |
| **Send messages** | Yes | Yes | Yes |
| **Memory search** | All | Own scope + global | Own scope + global |

### How to assign roles

- **Admin**: Set `role: admin` when creating user. Full access to everything.
- **Power User**: Set `role: user` + check "Power User" on the Users page. Gets restricted tools with sandboxed access.
- **User**: Set `role: user`. Safe tools only — can chat, search web, read files, but cannot execute commands or write files.

---

## Channel Identity Linking

One person can message from multiple channels — Telegram AND WhatsApp — and it's all linked to one account with one memory.

```
  Telegram user 8606526093 ──┐
                              ├── same user account ── same memory
  WhatsApp +6580961895 ──────┘
```

### How it works

1. Person messages your bot on Telegram → appears in Pending Senders
2. Admin clicks "Add as User" → account created + Telegram linked
3. Same person messages on WhatsApp → appears in Pending again
4. Admin clicks "Link to Existing" → WhatsApp linked to same account
5. Both channels now share one memory profile, one session history

### Onboarding options

| In Channels page | For individuals | For groups |
|---|---|---|
| **"Add as User"** | Creates account + links channel + approves | N/A |
| **"Approve"** | N/A | Approves group for bot access |
| **"Dismiss"** | Ignores sender | Ignores group |

---

## Per-User Workspace

Each user gets their own isolated folder structure. Files created by one user are invisible to others.

```
workspace/
├── IDENTITY.md              Shared bot personality (all users see same bot)
├── SOUL.md                  Shared
├── RULES.md                 Shared
│
├── shared/                  TEAM SPACE — all users can read/write
│   ├── documents/           Team reports, exports, shared files
│   └── media/               Shared images
│
└── scopes/                  PRIVATE — one folder per user
    ├── {admin-uuid}/
    │   ├── documents/       Admin's personal files
    │   ├── media/           Admin's uploads
    │   └── memory/
    │       ├── PROFILE.md   "Prefers concise answers, works at Company X"
    │       └── sessions/    Daily conversation summaries
    │
    ├── {sruthi-uuid}/
    │   ├── documents/       Sruthi's personal files
    │   ├── media/           Sruthi's uploads
    │   └── memory/
    │       ├── PROFILE.md   "Name is Sruthi, interested in cooking"
    │       └── sessions/
    │
    └── group_telegram_.../
        └── memory/          Group conversation memory
            ├── PROFILE.md   "This group discusses project updates"
            └── sessions/
```

### What each user can access

| Path | Admin | User (own) | User (other) |
|---|---|---|---|
| Persona files (IDENTITY.md, etc.) | Read | Read | Read |
| `shared/documents/` | Read/Write | Read/Write | Read/Write |
| `scopes/{my-uuid}/` | Read/Write | Read/Write | — |
| `scopes/{other-uuid}/` | Read/Write | **Blocked** | **Blocked** |
| `scopes/` (directory listing) | Yes | **Blocked** | **Blocked** |

### Personal vs shared files

When a user asks the agent to create a file:
- **Default**: saved to their personal `documents/` folder
- **"Save to shared"**: saved to `shared/documents/` (team-accessible)
- The agent is instructed about this distinction in its system prompt

### Media uploads

When a user sends a file (PDF, image, voice note) via any channel:
- **Linked user**: saved to `scopes/{uuid}/media/` (personal, only they can access)
- **Unlinked sender**: saved to `shared/media/` (team-accessible)
- **Web upload**: saved to `scopes/{uuid}/media/` (authenticated by API key)

This applies to Telegram photos/documents/voice, WhatsApp media, and web chat file uploads.

---

## Tool Permissions

Admin controls which tools each role can use from **Settings → Tool Permissions**.

### Four permission levels

| Level | What happens |
|---|---|
| **Allow** | Tool available to everyone with this role |
| **Power User only** | Only admin + users with Power User flag |
| **Confirm first** | Agent asks user for confirmation before running |
| **Deny** | Tool hidden from agent + blocked at execution |

### Default configuration

| Tool | Default for "User" role |
|---|---|
| `exec` | Power User only |
| `write_file` | Power User only |
| `edit_file` | Power User only |
| `manage_cron` | Power User only |
| `manage_plugins` | Power User only |
| All other tools (20+) | Allow |

### How to customize

1. Go to **Settings → Tool Permissions**
2. Select role: User
3. Change any tool's dropdown: Allow / Power User only / Confirm first / Deny
4. Click **Save Permissions**
5. Changes apply immediately to all users with that role

### Exec safety modes

| User type | Exec mode | What's blocked |
|---|---|---|
| **Admin** | Unrestricted | Only catastrophic commands (rm -rf /, shutdown, curl\|sh) |
| **Power User** | Sandboxed | Above + persona files + source code + secrets + cross-scope access + confirmation for risky commands |
| **Regular User** | Denied | Cannot use exec at all |

---

## Cron Jobs

Cron jobs are stored in the database with per-user ownership.

| User type | Can create crons? | Can see? |
|---|---|---|
| **Admin** | Yes (via UI + agent) | All crons in admin page |
| **Power User** | Yes (via agent) | Own crons at `/my/cron` |
| **Regular User** | No (manage_cron denied) | N/A |

When a Power User creates a cron via the agent, it runs with **their permissions** — not admin. Their cron jobs can only use tools they have access to.

---

## User Dashboard (`/my/`)

Non-admin users see a personal dashboard instead of the admin panel:

| Page | What it shows |
|---|---|
| **Dashboard** (`/my/`) | Session count, token usage, cost summary |
| **My Sessions** (`/my/sessions`) | Own chat sessions with message viewer |
| **My Usage** (`/my/usage`) | Token breakdown by model, input/output, cost |
| **My Cron Jobs** (`/my/cron`) | Cron jobs created via the agent |

- **Admin** → chat sidebar shows "Admin Dashboard" → `/admin/` (14 pages)
- **Non-admin** → chat sidebar shows "My Dashboard" → `/my/` (4 pages)

---

## User Management (Admin)

### Users page (`/admin/users`)

| Action | Description |
|---|---|
| **Create user** | Name, email, role, Power User flag. API key shown once. |
| **Edit user** | Change name, email, role, Power User flag |
| **Link sender** | Connect Telegram/WhatsApp identity → shows unlinked sessions to click |
| **Regenerate API key** | Requires typing "REGENERATE" to confirm. Old key invalidated. |
| **Deactivate** | Soft delete — reversible. All access blocked. Sender links removed. |
| **Reactivate** | Restores access |
| **Permanent delete** | Irreversible — sessions preserved for audit, user row deleted |
| **Self-protection** | Cannot deactivate/delete/demote yourself |

### What happens when a user is deactivated

1. All API calls return 403 "Account deactivated"
2. Login returns 403 (key is valid but account disabled)
3. WebSocket auth rejects immediately
4. Channel links removed (can't message via Telegram/WhatsApp)
5. Sessions preserved for audit
6. Reversible — admin can reactivate anytime

---

## Group Chats

Groups (Telegram groups, WhatsApp groups) work differently from individual users:

| Aspect | Individual | Group |
|---|---|---|
| Session ownership | Linked to user account | No owner (user_id = NULL) |
| Memory | Personal (per user UUID) | Shared group memory |
| Tool permissions | Per the user's role | Per the individual sender's role |
| Onboarding | "Add as User" | "Approve" |
| Scope directory | `scopes/{uuid}/` | `scopes/group_{channel}_{chatId}/` |

The bot remembers group context across sessions ("last week we discussed X in this group").

---

## Security Summary

| Layer | What it does |
|---|---|
| **API key auth** | SHA-256 hashed, per-user, shown once |
| **Active check** | Deactivated users blocked at middleware + WebSocket + login |
| **Admin guard** | Non-admin redirected from `/admin/*` pages |
| **scopedSafePath** | File tools enforce per-user scope boundaries |
| **Exec sandboxing** | Admin=unrestricted, Power User=pattern blocks+scoped cwd, User=denied |
| **Memory isolation** | Search returns only own scope + global memory |
| **Tool permissions** | DB-driven, double-enforced (prompt + execution), admin-configurable |
| **Output redaction** | API keys, tokens, secrets auto-stripped from agent responses |
| **Audit trail** | Every tool call logged with tamper-evident hash chain |

---

## Migration from Single-User

If upgrading from a single-user deployment:

1. **Database**: Migrations run automatically on startup (SQLite 008-010, Postgres 002-004)
2. **Documents**: `documents/` and `media/` auto-migrate to `shared/` on first startup
3. **Cron jobs**: `cron-jobs.json` auto-migrates to database, file renamed to `.migrated`
4. **Scopes**: Old `channel:senderId` scopes auto-migrate to user UUID scopes when senders are linked
5. **Existing admin**: Keeps working — `active=1`, `elevated=0` defaults are safe
6. **No downtime**: All migrations are non-destructive and run on startup
