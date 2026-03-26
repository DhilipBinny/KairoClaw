# Multi-User Architecture

How KairoClaw isolates users, scopes workspace access, and enforces permissions.

---

## 1. User Model

```
                        +-----------+
                        |  tenants  |  (1 per deployment)
                        +-----+-----+
                              |
              +---------------+---------------+
              |                               |
        +-----+-----+                  +-----+-----+
        |   users   |                  |   users   |
        | role=admin|                  | role=user |
        | elevated=0|                  | elevated=? |
        +-----+-----+                  +-----+-----+
              |                               |
              |                        +------+------+
              |                        | sender_links|
              |                        +------+------+
              |                               |
        +-----+-----+                  +-----+-----+
        |  sessions |                  |  sessions |
        | (all)     |                  | (own only)|
        +-----------+                  +-----------+
```

### Roles

| Role | Admin UI | All Tools | Dangerous Tools | See All Sessions |
|------|----------|-----------|-----------------|------------------|
| **admin** | Full access | Yes | Yes | Yes |
| **user** | Blocked (redirect to /) | Safe only | No | Own only |
| **user + power** | Blocked | Yes | Yes (elevated flag) | Own only |
| **unlinked sender** | No access | Safe only | No | N/A |

### Power User Tools (require admin or power user by default)

Configured via **Settings → Tool Permissions**. Default Power User tools:

```
exec, write_file, edit_file, manage_cron, manage_plugins
```

> Admin can change any tool to any permission level (allow / deny / power_user / confirm)
> from the Settings page. The list above is just the default seed — nothing is hardcoded.

### Open Tools (available to all users including unlinked senders by default)

14 built-in tools open by default:

```
read_file, list_directory, memory_search, memory_read, inspect_image,
web_fetch, web_search, send_message, send_file, send_email, session_status,
read_pdf, spawn_agent, kill_agent
```

### Tool Permission Admin (Settings page)

Admin can further restrict safe tools per role via the Settings page:
- Toggle any tool to Deny for the "user" role
- Dangerous tools shown as locked (requires Power User flag per user)
- MCP tools auto-listed and toggleable
- Changes write to `tool_permissions` table, apply immediately to all users with that role

---

## 2. Channel Identity Linking

```
  Telegram user 8606526093            WhatsApp +6580961895
         |                                    |
         v                                    v
  +------+------+                     +-------+------+
  | sender_links|                     | sender_links |
  | channel:    |                     | channel:     |
  |  telegram   |                     |  whatsapp    |
  | sender_id:  |                     | sender_id:   |
  |  8606526093 |                     |  6580961895  |
  +------+------+                     +-------+------+
         |                                    |
         +----------------+-------------------+
                          |
                    +-----+-----+
                    |   users   |
                    | "Sruthi"  |  <-- same user, two channels, ONE scope
                    +-----------+
```

### How a message is resolved to a user

```
Message arrives from Telegram/WhatsApp
        |
        v
  Is inbound.userId a valid user UUID?  --(yes)--> user found (web/API)
        |
       (no)
        v
  Look up sender_links by (channel, sender_id)
        |
        +-- found --> get user by link.user_id --> user found
        |
        +-- not found --> unlinked sender (role=user, restricted)
```

### User context assignment

```
  Resolved user (linked via sender_links or API key):
    → context.user = { id: UUID, role: from DB, elevated: from DB }

  Unlinked sender (real channel, no user account):
    → context.user = { id: 'anonymous', role: 'user', elevated: false }

  Cron / internal / heartbeat (system channels):
    → context.user = { id: 'system', role: 'admin', elevated: true }
```

### Group messages

```
  chat_id starts with "telegram:-" or contains "@g.us"?
        |
       (yes)
        v
  Session user_id = NULL always (groups are shared, not owned)
  Tool permissions = per the INDIVIDUAL SENDER (not the group)
  Memory scope = GROUP scope (shared group memory, not sender's personal memory)
```

---

## 3. Workspace & Scope Isolation

### Three scope types

| Scope Type | Key Format | Created When | Memory | Tools |
|---|---|---|---|---|
| **User (UUID)** | `675390be-...` | Linked user messages | Personal PROFILE.md + sessions | Scoped to own dir |
| **Group** | `group_telegram_-100332...` | Group message arrives | Shared group PROFILE.md + sessions | Per-sender permissions |
| **Unlinked sender** | `telegram:9876543` | Unlinked person messages | Temporary isolated memory | Restricted (user role) |

### Directory Structure

```
/data/                                    <-- state directory (AGW_STATE_DIR)
  +-- config.json                         <-- all configuration
  +-- secrets.enc                         <-- encrypted API keys (AES-256-GCM)
  +-- master.key                          <-- encryption master key (BACK UP!)
  +-- gateway.db                          <-- SQLite database
  +-- cron-jobs.json                      <-- scheduled tasks
  +-- plugins.json                        <-- plugin config
  +-- logs/                               <-- server-YYYY-MM-DD.log (7-day retention)
  +-- whatsapp/                           <-- WhatsApp session auth files
  +-- media/                              <-- uploaded PDFs, voice messages, images
  |
  +-- workspace/                          <-- agent workspace (config.agent.workspace)
        |
        +-- IDENTITY.md                   <-- shared persona (protected, read-only)
        +-- SOUL.md                       <-- shared persona (protected)
        +-- RULES.md                      <-- shared rules (protected)
        +-- USER.md                       <-- global user profile (fallback)
        |
        +-- documents/                    <-- shared writable space (all users)
        +-- media/                        <-- agent-generated images
        |
        +-- memory/                       <-- global memory (cron/system only)
        |     +-- PROFILE.md
        |     +-- sessions/
        |
        +-- scopes/                       <-- ISOLATED scope directories
              |
              |  --- USER SCOPES (by UUID) ---
              |
              +-- 675390be-.../           <-- Admin (Binny)
              |     +-- USER.md           <-- personal profile
              |     +-- memory/
              |           +-- PROFILE.md  <-- merged from ALL channels
              |           +-- sessions/
              |                 +-- 2026-03-21.md
              |                 +-- 2026-03-22.md
              |
              +-- 0ccce21b-.../           <-- Sruthi
              |     +-- memory/
              |           +-- PROFILE.md
              |           +-- sessions/
              |
              |  --- GROUP SCOPES ---
              |
              +-- group_telegram_-100332../ <-- Telegram group
              |     +-- memory/
              |           +-- PROFILE.md  <-- group context memory
              |           +-- sessions/
              |
              +-- group_whatsapp_12036.../ <-- WhatsApp group
              |     +-- memory/
              |           +-- PROFILE.md
              |           +-- sessions/
              |
              |  --- UNLINKED SENDER SCOPES (temporary) ---
              |
              +-- telegram:9876543/       <-- unlinked sender
                    +-- USER.md           <-- auto-seeded
                    +-- memory/
```

### How scope key is derived

```
Message arrives
        |
        v
  Is it a GROUP message?  (telegram:- or @g.us)
        |
        +-- YES: scopeKey = group_{channel}_{sanitized_chatId}
        |        Shared group memory. No USER.md seeded.
        |
        +-- NO: Is user resolved via sender_links?
              |
              +-- YES: scopeKey = user UUID (e.g. "675390be-...")
              |        One scope shared across all their channels.
              |
              +-- NO:  scopeKey = channel:senderId (e.g. "telegram:9876543")
                       Temporary scope until onboarded as a user.
```

### Scope migration (automatic on startup)

When a sender is linked to a user account, any existing `channel:senderId` scope
directory is automatically merged into the user's UUID scope directory:

- Session files (2026-03-21.md): always appended (never overwrites)
- Memory PROFILE.md: newer file wins
- USER.md: newer wins
- Old channel:sender directory removed after merge
- Orphaned memory_chunks in DB cleaned up (files that no longer exist on disk)

Safe to run repeatedly — skips already-migrated dirs.

### Access Rules (scopedSafePath)

```
+---------------------------+---------+--------------------+---------------+
|      Path                 |  Admin  |  User (own scope)  |  User (other) |
+---------------------------+---------+--------------------+---------------+
| IDENTITY.md               |  read   |  read              |  read         |
| SOUL.md                   |  read   |  read              |  read         |
| documents/*               |  r/w    |  r/w               |  r/w          |
| media/*                   |  r/w    |  r/w               |  r/w          |
| scopes/{MY_SCOPE}/*       |  r/w    |  r/w               |  --           |
| scopes/{OTHER_SCOPE}/*    |  r/w    |  BLOCKED           |  BLOCKED      |
| scopes/ (listing)         |  r/w    |  BLOCKED           |  BLOCKED      |
| /tmp/*                    |  r/w    |  r/w               |  r/w          |
+---------------------------+---------+--------------------+---------------+
```

### scopedSafePath decision flow

```
scopedSafePath(path, workspace, context)
        |
        v
  Run safePath(path, workspace)  -- traversal/symlink/null-byte check
        |
        v
  Is user admin?  --(yes)--> ALLOW (unrestricted)
        |
       (no)
        v
  Is path inside scopes/ directory?
        |
        +-- (no) --> ALLOW (documents/, media/, persona files, /tmp)
        |
        +-- (yes) -->  Is it scopes/ root?
                          |
                          +-- (yes) --> DENY ("cannot list other users' directories")
                          |
                          +-- (no) -->  Extract scope from path
                                        |
                                        Is it MY scope?
                                          |
                                          +-- (yes) --> ALLOW
                                          +-- (no)  --> DENY
```

---

## 4. Tool Permission Pipeline

### Layer 1: DB-driven permission check (unified, no hardcoded list)

```
checkToolPermission(toolName, userRole, db, tenantId, elevated)

admin?                          → always ALLOW
DB rule = 'allow'               → ALLOW
DB rule = 'deny'                → DENY (hidden from LLM + blocked at execution)
DB rule = 'power_user' + elevated → ALLOW
DB rule = 'power_user' + !elevated → DENY
DB rule = 'confirm'             → ALLOW (flagged for confirmation)
No matching rule                → ALLOW (open by default)
```

All permission logic is driven by the `tool_permissions` table.
There is no hardcoded dangerous-tools list in the code — admin controls
everything from Settings → Tool Permissions.

### Layer 2: DB permission rules (admin-configurable)

```
tool_permissions table:
  (tenant_id, role, tool_pattern, permission)

  tool_pattern supports glob: "mcp__*", "web_*", exact match
  permission: allow | deny | power_user | confirm
  No matching rule → ALLOW (tools allowed unless explicitly denied)
```

### Layer 3: Scope enforcement at execution

```
Tool executes with context (scopeKey, user.role)
  |
  +-- File tools: scopedSafePath blocks cross-scope access
  +-- Exec tool: cwd = user's scope dir, command checked for scope references
  +-- Memory search: SQL filter restricts to own scope + global
```

### Double enforcement

Both applied at **prompt time** (what LLM sees) AND **execution time** (when tool runs):

```
getDefinitions()  →  checkToolPermission()  →  denied tools hidden from LLM
registry.execute() → checkToolPermission() → denied tools return error + audit log
```

### Full tool access matrix

```
                    | admin | user | user+power | unlinked sender |
  ------------------+-------+------+------------+-----------------+
  read_file         |  all  |scoped| scoped     | scoped          |
  write_file        |  all  |DENIED| scoped     | DENIED          |
  edit_file         |  all  |DENIED| scoped     | DENIED          |
  list_directory    |  all  |scoped| scoped     | scoped          |
  exec              |  all  |DENIED| scoped     | DENIED          |
  manage_cron       |  all  |DENIED| scoped     | DENIED          |
  manage_plugins    |  all  |DENIED| scoped     | DENIED          |
  memory_search     |  all  |scoped| scoped     | scoped          |
  memory_read       |  all  |scoped| scoped     | scoped          |
  inspect_image     |  all  |scoped| scoped     | scoped          |
  read_pdf          |  all  |scoped| scoped     | scoped          |
  web_fetch         |  all  | all  | all        | all             |
  web_search        |  all  | all  | all        | all             |
  send_message      |  all  | all  | all        | all             |
  send_file         |  all  | all  | all        | all             |
  send_email        |  all  | all  | all        | all             |
  session_status    |  all  | all  | all        | all             |
  spawn_agent       |  all  | all  | all        | all             |
  kill_agent        |  all  | all  | all        | all             |
  MCP tools         |  all  | per DB rules      | per DB rules    |
  ------------------+-------+------+------------+-----------------+

  "scoped" = scopedSafePath enforced (own scope + shared globals only)
  "all"    = no path restriction (web/messaging tools don't access filesystem)
  "DENIED" = default power_user permission (hidden + blocked unless elevated)

  NOTE: All defaults above are DB-seeded and fully configurable by admin.
```

---

## 5. Database Tables

```
+-------------------+         +-------------------+
|     tenants       |         |      users        |
|-------------------|    1:N  |-------------------|
| id (PK)           +-------->| id (PK)           |
| name              |         | tenant_id (FK)    |
| slug              |         | name, email       |
+-------------------+         | role (admin/user) |
                              | elevated (0/1)    |
                              | active (0/1)      |
                              | api_key_hash      |
                              | deactivated_at    |
                              +--------+----------+
                                       |
                         +-------------+-------------+
                         |                           |
                +--------+--------+         +--------+--------+
                |  sender_links   |         |    sessions     |
                |-----------------|         |-----------------|
                | id (PK)         |         | id (PK)         |
                | tenant_id       |         | tenant_id       |
                | channel_type    |         | user_id (FK)    |  <-- NULL for groups
                | sender_id       |         | channel          |
                | user_id (FK)    |         | chat_id          |
                | linked_at       |         | turns, tokens    |
                | linked_by       |         +---------+--------+
                +-----------------+                   |
                                              +-------+-------+
                UNIQUE(tenant_id,             |   messages    |
                  channel_type,               |   tool_calls  |
                  sender_id)                  |   usage_records|
                                              +---------------+

                +-------------------+
                | tool_permissions  |  <-- admin-configurable per role
                |-------------------|
                | tenant_id         |
                | role              |
                | tool_pattern      |  (glob: "mcp__*", "exec", "*")
                | permission        |  (allow / deny / confirm)
                +-------------------+
```

---

## 6. Auth Flow

```
API Request with Bearer token
        |
        v
  Auth middleware (middleware.ts)
        |
        v
  Hash API key -> lookup in users table
        |
        +-- not found --> 401
        |
        +-- found but active=0 --> 403 "Account deactivated"
        |
        +-- found + active --> set request.user = {
              id, tenantId, name,
              role: admin|user,
              elevated: true|false
            }

  WebSocket auth (webchat.ts):
        |
        v
  Same API key lookup + active check
  Sets clientId = user UUID (stable scope, not ephemeral per-tab)
  auth.error → client stops reconnecting (no rate limit loop)

  Admin routes (/api/v1/admin/*):
        |
        v
  requireRole('admin') preHandler → 403 if not admin

  Admin UI (/admin/*):
        |
        v
  +layout.svelte checks role on mount
        |
        +-- already authenticated as admin → show immediately (no flash)
        +-- not authenticated → checkAuth() → spinner while loading
        +-- not admin → redirect to /
```

---

## 7. Onboarding Flow

```
  New person messages bot via Telegram
        |
        v
  Not in allowFrom → recorded in pending_senders (status=pending)
  Agent does NOT respond (sender is blocked)
        |
        v
  Admin sees in Channels page:
  +--------------------------------------------------+
  |  [telegram] "Bala" (8523037700)                   |
  |  3 msgs  |  [Add as User]  [Dismiss]             |
  +--------------------------------------------------+
  (Groups show [Approve] [Dismiss] instead)
        |
        v
  Admin clicks "Add as User" → modal:
  +--------------------------------------------------+
  |  Add as User                                      |
  |  [telegram] Bala  8523037700                      |
  |                                                   |
  |  Create New User          Link to Existing        |
  |  Name: [Bala          ]   [Select user v]         |
  |  Role: [User v]                                   |
  |  [ ] Power User                                   |
  |                                                   |
  |  [Cancel]  [Create Account]                       |
  +--------------------------------------------------+
        |
        v
  Backend (POST /onboard):
  1. Create user account → API key generated (shown ONCE)
  2. Create sender_link (telegram:8523037700 → user UUID)
  3. Add 8523037700 to config.channels.telegram.allowFrom
  4. Mark pending_sender as approved
  5. Backfill existing sessions with user_id
  6. On next startup: channel:sender scope merged into UUID scope
        |
        v
  Alternatively: Admin → Users → Create User → Link Sender
  (Link modal shows existing unlinked sessions as clickable list)
```

---

## 8. Session Ownership

```
  Sessions page (non-admin):
    Only shows sessions WHERE user_id = current_user.id

  Sessions page (admin):
    Shows all sessions with user_name column

  Session detail/delete (non-admin):
    Checks session.user_id === current_user.id → 403 if mismatch

  Group sessions:
    user_id = NULL always
    Only visible to admin in sessions list
    Have their own group memory scope
```

---

## 9. Memory Scoping

### Per-user memory (individual chats)

```
  Agent builds system prompt:
    1. Load shared persona (IDENTITY.md, SOUL.md, RULES.md) — global
    2. Load USER.md — cascaded (scope first, then global fallback)
    3. Load PROFILE.md — from scopes/{userUUID}/memory/
    4. Load recent sessions — from scopes/{userUUID}/memory/sessions/

  After conversation (5+ turns):
    Auto-summarize → write to scopes/{userUUID}/memory/sessions/YYYY-MM-DD.md
    Consolidation → merge sessions into PROFILE.md (periodic)
```

### Per-group memory (group chats)

```
  Agent builds system prompt:
    1. Load shared persona — global
    2. Load PROFILE.md — from scopes/group_{channel}_{chatId}/memory/
    3. Load recent sessions — from group scope

  After conversation (5+ turns):
    Auto-summarize → write to group scope's sessions/
    Group memory accumulates context: "this group discusses X, decided Y"
```

### Global memory (cron/system)

```
  Cron and internal channels use workspace/memory/ (no scope)
```

### Memory search isolation

```
  Admin: sees ALL memory chunks (no filter)
  User:  sees own scope + global only (SQL: file_path LIKE 'scopes/{key}/%' OR NOT LIKE 'scopes/%')
  Orphaned chunks (stale file paths) cleaned up on startup
```

---

## 10. System Prompt Security

```
  Scoped user (Telegram/WhatsApp/Web):
    "Your files are in your personal scope directory."
    "SCOPE BOUNDARY: You are serving a single user.
     Do not attempt to access other users' directories."
    Does NOT expose: absolute workspace path, scopes/ structure, other users' keys

  Group chat:
    Same scope boundary instruction, but memory loads from group scope

  Cron/system:
    "Your files are organized in the workspace directory."
    No scope restrictions (admin context)
```

---

## 11. Deactivation & Deletion

```
  Deactivate user (soft delete):
    1. Set active=0, deactivated_at=now
    2. Remove all sender_links (can't message via channels)
    3. All API calls return 403 (middleware check)
    4. Login returns 403 (not 401 — key is valid but account disabled)
    5. WebSocket auth rejects with "Account deactivated"
    6. WebSocket client stops reconnecting (authFailed flag)
    7. Sessions preserved (for audit)
    8. Reversible: Reactivate sets active=1

  Hard delete:
    1. Delete sender_links
    2. Delete usage_records
    3. Nullify user_id on sessions (preserve for audit)
    4. Delete user row
    5. Irreversible
    6. Scope directory remains on disk (manual cleanup)
```

---

## 12. Admin Pages

| Page | What it shows |
|------|--------------|
| **Dashboard** | Health, user count (total + active), model |
| **Users** | All users with roles, links, sessions, usage. Create/edit/deactivate/delete. Link senders (shows unlinked sessions). Regenerate API keys. Self-protection (can't delete yourself). |
| **Channels** | Telegram + WhatsApp config. Pending senders: "Add as User" for individuals, "Approve" for groups. |
| **Sessions** | All sessions with user names. Filter by channel. View messages. |
| **Scoped Channels** | Memory scopes: user names (UUID scopes), group badge (group scopes). Click to view PROFILE.md and session notes. |
| **Settings** | Tool Permissions section: per-role allow/deny toggles for all tools. Dangerous tools shown as locked. |
| **MCP Servers** | Installed MCP tool servers. Tools auto-appear in permissions. |

---

## 13. Design Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| Single org per deployment | Simple. Multi-org = redeploy Docker. |
| Two roles (admin/user) + elevated flag | Viewer role dropped (unnecessary). Power user via toggle, not a third role. |
| Scope by user UUID, not channel:sender | One person = one memory across all channels. No split brain. |
| Groups get shared scope, not per-sender | Group memory is shared context. Individual permissions still enforced per sender. |
| Unlinked senders get user role (restricted) | Safe default. No admin escalation for unknown people in approved groups. |
| Cron/system gets admin context | Cron needs exec, file tools, etc. Intentional. |
| Tool permissions default to allow | Open by default for simplicity. Admin explicitly denies what they want blocked. |
| Session files append, never overwrite on merge | Prevents data loss when merging scopes from multiple channels. |
| API key shown once, stored as SHA-256 hash | Can't be recovered. Self-regen updates localStorage automatically. |
| scopedSafePath as single enforcement point | All file tools funnel through one function. Can't be bypassed. |
| Exec scope check is text-based (not sandbox) | Interim. Container sandbox is the proper long-term fix (backlog). |
