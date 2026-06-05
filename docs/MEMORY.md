# Memory System

The memory system gives the AI agent continuity across sessions. Without it, every conversation starts from zero — the agent doesn't know your name, preferences, or what you worked on yesterday.

---

## Architecture

Memory is **per-user scoped**. Each user gets an isolated memory directory derived from their user UUID, so no user can read or write another user's memories. Groups similarly get their own scope.

- **Per-user memory:** `workspace/scopes/{user-uuid}/memory/`
- **Per-group memory:** `workspace/scopes/group_{channel}_{chatId}/memory/`
- **Global memory:** `workspace/memory/` — used only by cron jobs and system sessions

The scope key is derived from the user's UUID (not `channel:senderId`), so a user who chats via both Telegram and WhatsApp shares a single memory scope.

---

## Memory Layers

There are four memory layers, from most persistent to most ephemeral:

```
┌─────────────────────────────────────────┐
│          Long-Term Memory               │
│      {scope}/memory/PROFILE.md          │
│                                         │
│  Permanent user profile:                │
│  - Name, role, expertise                │
│  - Communication preferences            │
│  - Key decisions and context            │
│                                         │
│  Updated by: consolidation              │
│  Expires: never                         │
└─────────────────────────────────────────┘
                    ▲
                    │ consolidate (periodic)
                    │
┌─────────────────────────────────────────┐
│          Short-Term Memory              │
│  {scope}/memory/sessions/YYYY-MM-DD.md  │
│                                         │
│  Daily session notes:                   │
│  - What was discussed                   │
│  - Decisions made                       │
│  - Tasks completed                      │
│                                         │
│  Updated by: auto-summarize             │
│  Expires: after 7 days                  │
└─────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────┐
│         Session Memory                  │
│  {scope}/memory/session-context/{id}.md │
│                                         │
│  Structured notes for the active        │
│  session (Current State, Key Info,      │
│  Decisions, Files Touched, Worklog).    │
│  Extracted mid-session as context       │
│  grows, used as free compaction summary │
│                                         │
│  Updated by: token threshold trigger    │
│  Expires: after 7 days                  │
└─────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────┐
│          Pinned Notes                   │
│      {scope}/memory/PINNED.md           │
│                                         │
│  User-curated notes injected into       │
│  every prompt. Managed via memory_pin   │
│  and memory_forget tools.               │
│                                         │
│  Updated by: user (via tools)           │
│  Expires: never (manual removal)        │
└─────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────┐
│           Conversation                  │
│                                         │
│  User chats via Web/Telegram/WhatsApp   │
│  Agent processes and responds           │
│  Session ends                           │
└─────────────────────────────────────────┘
```

---

## How It Works

### 1. Session Memory (during conversation)

**When:** Automatically triggered when the conversation context grows past token thresholds.

- **Initial extraction:** After ~8,000 tokens of context
- **Re-extraction:** Every ~4,000 additional tokens

**Process:**
1. The LLM receives the recent conversation and extracts structured notes
2. Notes are written to `memory/session-context/{sessionId}.md`
3. Sections: Current State, Task/Request, Key Information, Decisions Made, Files Touched, Errors & Corrections, Worklog

**Key benefit:** Session memory doubles as a free compaction summary. When the context window fills up, the agent uses these structured notes instead of making an extra LLM call for summarization.

### 2. Auto-Summarize (after each conversation)

**When:** After every real conversation with 3+ user turns (configurable, default overridden to 5 at the call site).

**Skips:** Cron job executions, internal/sub-agent sessions, single-turn interactions.

**Process:**
1. Collect all user + assistant messages from the session (capped at 8,000 chars)
2. Read existing `PROFILE.md` + today's session notes
3. Ask the LLM: "What NEW facts from this conversation aren't already in memory?"
4. If new facts found, append to `memory/sessions/YYYY-MM-DD.md`
5. If nothing new, skip (no duplicate writes)

**Key design decision:** The LLM sees existing memory BEFORE extracting, so it only saves genuinely new information.

### 3. Consolidation (periodic)

**When:** Can be triggered daily via cron, or manually.

**Process:**
1. Read all session files + existing `PROFILE.md`
2. Ask the LLM: "Merge these session notes into an updated profile"
3. LLM produces a clean, deduplicated profile
4. Write new `PROFILE.md` (replaces old one)

**Result:** Session-level details get distilled into permanent profile facts. Temporary details naturally fall away.

### 4. Cleanup (automatic)

Session files and session-context files older than 7 days are automatically deleted when a new session summary is saved.

---

## File Structure

```
workspace/
  memory/                                  <- global (cron/system only)
    PROFILE.md
    PINNED.md
    sessions/
    session-context/
  scopes/
    {user-uuid}/memory/                    <- per-user
      PROFILE.md
      PINNED.md
      sessions/
        2026-03-19.md                      <- today's session notes
        2026-03-18.md                      <- yesterday's notes
        (files older than 7 days auto-deleted)
      session-context/
        {sessionId}.md                     <- active session structured notes
        (files older than 7 days auto-deleted)
    group_telegram_{chatId}/memory/        <- per-group
      PROFILE.md
      sessions/
```

---

## What the Agent Sees

At the start of every conversation, the system prompt includes (in order):

1. **User Profile** — from `PROFILE.md` (max 3,000 chars)
2. **Pinned Notes** — from `PINNED.md` (always loaded if present)
3. **Session Notes** — from `session-context/{sessionId}.md` (max 3,000 chars, skipped after compaction)
4. **Recent Daily Sessions** — from `sessions/YYYY-MM-DD.md` (max 1,500 chars x 3 most recent days)

```markdown
### User Profile (Long-Term Memory)
- Name: YourName
- Role: Full-stack developer
- Preferences: concise responses
- Channels: Telegram, WhatsApp

### Pinned Notes (always load)
- Deploy to staging before merging to main
- Use pnpm, not npm

### Session Notes (Current Session)
## Current State
Working on API rate limiting implementation
## Key Information
- Rate limiter uses in-memory Map per process
...

### Recent Sessions
#### 2026-03-19
- Implemented structured logging with categories
- Redesigned admin nav
```

---

## Memory Tools

Users can manage their memory via the agent:

| Tool | What it does |
|------|-------------|
| `memory_write` | Save a fact to your profile |
| `memory_pin` | Pin a note that's always loaded into every prompt |
| `memory_forget` | Remove a pinned note |
| `memory_read` | Read your current profile and pinned notes |
| `memory_search` | Search across all memory files by keyword |

---

## Memory Search Isolation

Non-admin users can only search their own scope plus global memory. Admin users can search all scopes. A user's memories are never leaked to other users.

The search system uses composite scoring: profile matches get a 1.5x boost, recent files score higher (14-day recency half-life), and keyword relevance is the base signal.

---

## Configuration

| Setting | Default | Location |
|---------|---------|----------|
| Min turns to trigger auto-summarize | 3 (overridden to 5 at call site) | `memory-engine/auto-memory.ts` |
| Session retention | 7 days | `memory-engine/auto-memory.ts` |
| Profile max in prompt | 3,000 chars | `agent-core/prompt.ts` |
| Session memory max in prompt | 3,000 chars | `agent-core/prompt.ts` |
| Daily session notes max in prompt | 1,500 chars x 3 days | `agent-core/prompt.ts` |
| Conversation text cap for extraction | 8,000 chars | `memory-engine/auto-memory.ts` |
| Session memory init threshold | 8,000 tokens | `memory-engine/session-memory.ts` |
| Session memory growth threshold | 4,000 tokens | `memory-engine/session-memory.ts` |
| Skipped channels | `cron`, `internal` | `memory-engine/auto-memory.ts` |

All memory injection limits can be overridden via `config.agent.contextInjection`:
- `profileMaxChars`, `sessionMemoryMaxChars`, `dailySessionDays`, `dailySessionMaxChars`

---

## Future Enhancements

### Semantic Search
Use embeddings to search memory by relevance instead of keyword matching. Load only the most relevant memories into context.

### Memory Categories
Split the profile into selectively-loadable sections (User, Projects, Decisions, People).

### Cross-Session Threads
Track conversation threads across sessions — automatically load relevant prior context.

### Memory UI
Admin page to view, edit, and manage memory files per user.
