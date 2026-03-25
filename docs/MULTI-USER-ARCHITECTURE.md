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

### Dangerous Tools (require admin or power user)

```
exec, manage_cron, write_file, delete_file
```

### Safe Tools (available to all users)

```
read_file, edit_file, list_directory, memory_search, memory_read,
inspect_image, web_fetch, web_search, send_message, send_file, session_status
```

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
                    | "Sruthi"  |  <-- same user, two channels
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
        +-- not found --> user_id = NULL (unlinked sender)


  For GROUP messages:
        |
        v
  chat_id starts with "telegram:-" or contains "@g.us"?
        |
       (yes)
        v
  user_id = NULL always (groups are shared, not owned)
```

---

## 3. Workspace & Scope Isolation

### Directory Structure

Scopes are keyed by **user UUID** — one directory per user, shared across all channels.
When a user messages via Telegram, WhatsApp, or web, they all use the same scope.

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
        +-- IDENTITY.md                   <-- shared persona (protected, read-only for agent)
        +-- SOUL.md                       <-- shared persona (protected)
        +-- RULES.md                      <-- shared rules (protected)
        +-- USER.md                       <-- global user profile (fallback for unscoped)
        |
        +-- documents/                    <-- shared writable space for all users
        |     +-- report.pdf
        |     +-- analysis.md
        |
        +-- media/                        <-- agent-generated images
        |
        +-- memory/                       <-- global memory (cron/system sessions only)
        |     +-- PROFILE.md
        |     +-- sessions/
        |
        +-- scopes/                       <-- PER-USER scope directories (by UUID)
              |
              +-- 675390be-.../           <-- Admin (Binny)
              |     +-- USER.md           <-- personal profile
              |     +-- memory/
              |           +-- PROFILE.md  <-- long-term memory (all channels merged)
              |           +-- sessions/
              |                 +-- 2026-03-21.md
              |                 +-- 2026-03-22.md
              |                 +-- 2026-03-23.md
              |
              +-- 0ccce21b-.../           <-- Sruthi
              |     +-- memory/
              |           +-- PROFILE.md  <-- her memory (WhatsApp + any future channel)
              |           +-- sessions/
              |
              +-- 85bd5d75-.../           <-- Bala
              |     +-- USER.md
              |     +-- memory/
              |           +-- PROFILE.md  <-- merged from Telegram + WhatsApp
              |           +-- sessions/
              |
              +-- telegram:9876543/       <-- unlinked sender (no user account yet)
                    +-- USER.md           <-- auto-seeded on first message
                    +-- memory/           <-- isolated until onboarded
```

### How scope key is derived

```
Message arrives
        |
        v
  User resolved via sender_links?
        |
        +-- YES: scopeKey = user UUID (e.g. "675390be-...")
        |        One scope shared across all their channels.
        |
        +-- NO:  scopeKey = channel:senderId (e.g. "telegram:9876543")
                 Temporary scope until they are onboarded as a user.
                 On onboard: old channel:sender scope is merged into user UUID scope.
```

### Scope migration (automatic on startup)

When a sender is linked to a user account, any existing `channel:senderId` scope
directory is automatically merged into the user's UUID scope directory:

- Memory PROFILE.md: newer file wins
- Session files (2026-03-21.md): appended if different content
- USER.md: newer wins
- Old channel:sender directory is removed after merge

This runs once on startup and is safe to run repeatedly (skips already-migrated dirs).

### Access Rules (scopedSafePath)

```
+---------------------------+-------------------------------------------+
|      Path                 |  Admin  |  User (own scope)  |  User (other) |
+---------------------------+---------+--------------------+---------------+
| IDENTITY.md               |  read   |  read              |  read         |
| SOUL.md                   |  read   |  read              |  read         |
| documents/*               |  r/w    |  r/w               |  r/w          |
| media/*                   |  r/w    |  r/w               |  r/w          |
| scopes/{MY_SCOPE}/*       |  r/w    |  r/w               |  --           |
| scopes/{OTHER_SCOPE}/*    |  r/w    |  BLOCKED           |  BLOCKED      |
| scopes/ (listing)         |  r/w    |  BLOCKED           |  BLOCKED      |
| /tmp/kairo/*              |  r/w    |  r/w               |  r/w          |
+---------------------------+---------+--------------------+---------------+
```

### How scopedSafePath works

```
scopedSafePath(path, workspace, context)
        |
        v
  Run safePath(path, workspace)  -- basic traversal/symlink check
        |
        v
  Is user admin?  --(yes)--> ALLOW (unrestricted)
        |
       (no)
        v
  Is path inside scopes/ directory?
        |
        +-- (no) --> ALLOW (documents/, media/, persona files, /tmp/kairo)
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
                                          +-- (no)  --> DENY ("cannot access other users' files")
```

---

## 4. Tool Permission Pipeline

### What the LLM sees (getDefinitions)

```
getDefinitions({ userRole, db, tenantId, elevated })
        |
        v
  For each registered tool:
        |
        v
  checkToolPermission(toolName, role, db, tenantId, elevated)
        |
        +-- admin?              --> ALLOW (always)
        |
        +-- dangerous + !elevated --> DENY (hidden from LLM)
        |
        +-- DB permission rules  --> allow/deny/confirm
        |
        +-- no rules             --> ALLOW (default open)

  Result: LLM only sees tools the user is allowed to use
```

### What happens at execution time

```
User asks agent to use a tool
        |
        v
  registry.execute(toolName, args, context)
        |
        v
  1. RBAC check (same as above)
     +-- deny --> return error, audit log "tool.denied"
        |
  2. Tool executor runs with context (includes scopeKey, user)
     +-- scopedSafePath enforces file boundaries
     +-- exec tool enforces cwd + command pattern checks
     +-- memory_search filters by scope
        |
  3. Audit log: tool.execute with name, args, result, duration
```

### Tool access matrix

```
                    | admin | user | user+power |
  ------------------+-------+------+------------+
  read_file         |  all  | scoped| scoped    |  <-- scopedSafePath enforced
  write_file        |  all  | DENIED| scoped    |  <-- dangerous tool
  edit_file         |  all  | scoped| scoped    |
  delete_file       |  all  | DENIED| scoped    |  <-- dangerous tool
  list_directory    |  all  | scoped| scoped    |
  exec              |  all  | DENIED| scoped    |  <-- dangerous tool, cwd=own scope
  manage_cron       |  all  | DENIED| scoped    |  <-- dangerous tool
  memory_search     |  all  | scoped| scoped    |  <-- SQL scope filter
  memory_read       |  all  | scoped| scoped    |  <-- scopedSafePath enforced
  web_fetch         |  all  | all   | all       |
  web_search        |  all  | all   | all       |
  send_message      |  all  | all   | all       |
  send_file         |  all  | all   | all       |
  session_status    |  all  | all   | all       |
  inspect_image     |  all  | scoped| scoped    |  <-- scopedSafePath enforced
  MCP tools         |  all  | per DB rules       |
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

  Admin routes (/api/v1/admin/*):
        |
        v
  requireRole('admin') preHandler
        |
        +-- role !== admin --> 401
        +-- admin --> proceed

  Admin UI (/admin/*):
        |
        v
  +layout.svelte checks getIsAuthenticated() + getUser().role
        |
        +-- not admin --> goto('/') redirect
        +-- admin --> render admin content
```

---

## 7. Onboarding Flow

```
  New person messages bot via Telegram
        |
        v
  Not in allowFrom --> recorded in pending_senders (status=pending)
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
  Admin clicks "Add as User" --> modal:
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
  1. Create user account --> API key generated
  2. Create sender_link (telegram:8523037700 --> user UUID)
  3. Add 8523037700 to config.channels.telegram.allowFrom
  4. Mark pending_sender as approved
  5. Backfill existing sessions: UPDATE sessions SET user_id = ?
     WHERE chat_id = 'telegram:8523037700' AND user_id IS NULL
        |
        v
  Admin sees API key once --> copies to share with user
  Bala's future messages are now tracked under their user account

  Alternatively: Admin --> Users page --> Create User --> Link Sender
  (Link modal shows existing unlinked sessions to click)
```

---

## 8. Session Ownership

```
  Sessions page (non-admin):
    Only shows sessions WHERE user_id = current_user.id

  Sessions page (admin):
    Shows all sessions, with user_name column

  Session detail/delete (non-admin):
    Checks session.user_id === current_user.id
    403 if mismatch

  Group sessions:
    user_id = NULL always
    Only visible to admin in sessions list
```

---

## 9. System Prompt (what the agent knows)

```
  Scoped user (Telegram/WhatsApp/Web):
    "Your files are in your personal scope directory."
    "SCOPE BOUNDARY: You are serving a single user.
     Do not attempt to access other users' directories."
    Memory paths: scopes/{scopeKey}/memory/PROFILE.md

  Unscoped (cron, system):
    "Your files are organized in the workspace directory."
    Memory paths: memory/PROFILE.md

  Neither version exposes:
    - Absolute workspace path (was: /data/workspace)
    - The scopes/ directory structure
    - Other users' scope keys
```

---

## 10. Deactivation & Deletion

```
  Deactivate user (soft delete):
    1. Set active=0, deactivated_at=now
    2. Remove all sender_links (can't message via channels)
    3. All API calls return 403
    4. WebSocket auth fails, no reconnect loop
    5. Sessions preserved (for audit)
    6. Reversible: Reactivate sets active=1

  Hard delete:
    1. Delete sender_links
    2. Delete usage_records
    3. Nullify user_id on sessions (preserve for audit)
    4. Delete user row
    5. Irreversible
```
