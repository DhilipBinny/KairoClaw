# Auto-Memory System

The auto-memory system gives the AI agent continuity across sessions. Without it, every conversation starts from zero — the agent doesn't know your name, preferences, or what you worked on yesterday.

---

## Architecture

```
┌─────────────────────────────────────────┐
│          Long-Term Memory               │
│      memory/PROFILE.md                  │
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
│    memory/sessions/YYYY-MM-DD.md        │
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
                    │ auto-summarize (after each session)
                    │
┌─────────────────────────────────────────┐
│           Conversation                  │
│                                         │
│  User chats via Web/Telegram/WhatsApp   │
│  Agent processes and responds           │
│  Session ends                           │
└─────────────────────────────────────────┘
```

## How It Works

### 1. Auto-Summarize (after each conversation)

**When:** After every real conversation that has 5+ user turns.

**Skips:** Cron job executions, heartbeat pings, single-turn interactions.

**Process:**
1. Collect all user + assistant messages from the session (capped at 8K chars)
2. Read existing `PROFILE.md` + today's session notes
3. Ask the LLM: "What NEW facts from this conversation aren't already in memory?"
4. If new facts found → append to `memory/sessions/YYYY-MM-DD.md`
5. If nothing new → skip (no duplicate writes)

**Key design decision:** The LLM sees existing memory BEFORE extracting, so it only saves genuinely new information. This prevents the duplication problem.

### 2. Consolidation (periodic)

**When:** Can be triggered daily via cron, or manually.

**Process:**
1. Read all session files from the past 7 days
2. Read existing `PROFILE.md`
3. Ask the LLM: "Merge these session notes into an updated profile"
4. LLM produces a clean, deduplicated profile
5. Write new `PROFILE.md` (replaces old one)

**Result:** Session-level details get distilled into permanent profile facts. Temporary details (debugging sessions, one-off tasks) naturally fall away.

### 3. Cleanup (automatic)

Session files older than 7 days are automatically deleted when a new session summary is saved. This prevents unbounded disk growth.

---

## File Structure

```
workspace/
  memory/
    PROFILE.md              ← long-term user profile (permanent)
    sessions/
      2026-03-19.md         ← today's session notes
      2026-03-18.md         ← yesterday's notes
      2026-03-17.md         ← ...
      (files older than 7 days auto-deleted)
  MEMORY.md                 ← legacy curated notes (still loaded)
```

## What the Agent Sees

At the start of every conversation, the system prompt includes:

```markdown
### User Profile (Long-Term Memory)
- Name: YourName
- Role: Full-stack developer
- Preferences: dev humor, emojis, concise responses
- Channels: Telegram (@your_bot), WhatsApp (+1987654321)
- Timezone: Asia/Singapore

### Recent Sessions
#### 2026-03-19
- Implemented structured logging with categories
- Redesigned admin nav (Configuration + Operations groups)

#### 2026-03-18
- Fixed WhatsApp group mentions (LID resolution)
- Built cron multi-target delivery
```

This gives the agent context without wasting tokens on duplicates.

---

## Configuration

| Setting | Value | Location |
|---------|-------|----------|
| Minimum turns to trigger | 5 | `loop.ts` → `minTurns: 5` |
| Session retention | 7 days | `auto-memory.ts` → `SESSION_RETENTION_DAYS` |
| Profile max size in prompt | 3000 chars | `prompt.ts` |
| Session notes max in prompt | 1500 chars × 3 days | `prompt.ts` |
| Conversation text cap | 8000 chars | `auto-memory.ts` |
| Skipped channels | `cron`, `heartbeat` | `auto-memory.ts` |

---

## Future Enhancements

### Semantic Search
Instead of loading the full profile + recent sessions into the prompt, use embeddings to search memory by relevance to the current conversation. Load only the most relevant memories.

### Explicit Memory Commands
- `/remember [fact]` — manually add to profile
- `/forget [fact]` — remove from profile
- `/memory` — show current profile

### Memory Categories
Split the profile into sections the agent can selectively load:
- **User**: personal info, preferences
- **Projects**: active work, repositories, tech stack
- **Decisions**: architectural choices, tool preferences
- **People**: contacts, team members mentioned

### Cross-Session Threads
Track conversation threads across sessions: "We were discussing X yesterday" → agent loads the relevant session notes automatically.

### Memory UI
Admin page to view, edit, and manage memory files. See what the agent knows about you, delete outdated facts, manually curate the profile.
