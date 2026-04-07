# Memory Architecture: KairoClaw vs Claude Code

Deep comparison based on source code analysis of both systems.

---

## 1. How KairoClaw Handles Memory Today

### Lifecycle

```
Startup → Index workspace .md files into memory_chunks table
Per-turn → Load PROFILE.md + last 3 session files into system prompt
Post-session → LLM extracts new facts → appends to sessions/YYYY-MM-DD.md
Periodic → consolidateMemory() merges sessions into PROFILE.md (manual trigger)
On-demand → memory_search tool queries chunked index
```

### Memory Types

KairoClaw has **2 memory layers**:


| Layer        | File                     | Retention | Purpose                      |
| ------------ | ------------------------ | --------- | ---------------------------- |
| **Profile**  | `PROFILE.md`             | Permanent | Long-term facts, preferences |
| **Sessions** | `sessions/YYYY-MM-DD.md` | 7 days    | Daily conversation notes     |


### Storage

```
workspace/scopes/{userId}/memory/
├── PROFILE.md              # Long-term (updated by consolidation)
└── sessions/
    ├── 2026-04-01.md        # Daily notes (auto-appended)
    ├── 2026-04-02.md
    └── 2026-04-03.md
```

### Context Injection

- **PROFILE.md**: Up to 3,000 chars loaded into dynamic system prompt suffix
- **Sessions**: Last 3 days, up to 1,500 chars each
- **Total memory in prompt**: ~~7,500 chars max (~~2K tokens)

### Auto-Memory

- Triggers after each session (min 3 user turns)
- Sends last 8,000 chars of conversation to LLM
- Extracts ONLY new facts not in existing memory
- Appends to today's session file
- Cleans up files >7 days old

### Search

- Keyword-based: SQL pre-filter + client-side scoring
- Chunks: 400 tokens with 80-token overlap
- Scoped per user (non-admins see own + global only)

---

## 2. How Claude Code Handles Memory

### Lifecycle

```
Startup → Discover CLAUDE.md files (managed/user/project/local) + load MEMORY.md index
Per-turn → Load memory prompt section + relevant memories into system prompt
Post-turn → Background fork extracts new memories (parallel reads → writes)
Post-turn → Session memory updated (separate from persistent memory)
Background → autoDream consolidates every 24h (if 5+ sessions touched)
Team → Sync memory to/from server (org-wide, per-repo)
```

### Memory Types

Claude Code has **4 typed memory categories** + session memory:


| Type          | Scope        | Purpose                                              |
| ------------- | ------------ | ---------------------------------------------------- |
| **user**      | Private      | User's role, goals, knowledge                        |
| **feedback**  | Private/Team | How to approach work (corrections + confirmations)   |
| **project**   | Team         | Ongoing work, initiatives, deadlines                 |
| **reference** | Team         | Pointers to external systems (Linear, Grafana, etc.) |
| **session**   | Ephemeral    | Current conversation state (12 structured sections)  |


### Storage

```
~/.claude/projects/<slug>/memory/
├── MEMORY.md          # Index (200 lines max)
├── user_role.md       # Topic files with frontmatter
├── feedback_testing.md
├── project_sprint.md
├── reference_linear.md
└── team/              # Org-wide shared memory
    ├── MEMORY.md
    └── *.md
```

### Context Injection

- **System prompt**: Full memory taxonomy instructions (how/when to save each type)
- **User context**: CLAUDE.md files labeled by source (managed > user > project > local)
- **Relevant memories**: Sonnet selects up to 5 most relevant per turn
- **Session memory**: Structured notes (12 sections, 2K tokens/section cap)

### Extraction

- Runs as **forked subagent** (shares parent's prompt cache)
- : if main agentzz wroMutual exclusionte memories, fork skips
- Turn 1: parallel reads; Turn 2: parallel writes (efficient)
- Max 5 turns per extraction
- Secret scanning before writes
- Cursor tracks last processed message

### Session Memory

- Separate from persistent memory
- 12 structured sections (title, state, files, workflow, errors, learnings, etc.)
- Updates when: 10K tokens init + 5K growth or 3 tool calls
- Used as compaction summary (replaces traditional LLM summarization)

### Auto-Dream (Consolidation)

- Gate chain: time (24h) → session count (5) → lock
- Phases: Orient → Gather signal → Consolidate → Prune index
- Background task with UI progress tracking
- Abortable by user

### Team Memory

- Server-synced per git repo
- Pull: server wins; Push: delta upload
- Secret scanning (40+ gitleaks rules) before upload
- Watcher for real-time sync on file changes

---

## 3. Gap Analysis

### What KairoClaw is missing vs Claude Code


| Gap                              | Claude Code has                                            | KairoClaw has                                   | Impact                                                       | Effort to add |
| -------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ | ------------- |
| **Typed memories**               | 4 types (user/feedback/project/reference) with frontmatter | 2 layers (profile + sessions), untyped          | Medium — typed memories are more searchable and maintainable | Medium        |
| **Memory index (MEMORY.md)**     | Central index file, 200 lines, always loaded               | No index — profile + sessions loaded raw        | Low — index gives the model a map of what's stored           | Low           |
| **Forked subagent extraction**   | Background fork shares parent cache, mutual exclusion      | Inline LLM call after session, no cache sharing | Medium — fork is cheaper (cache hit) and doesn't block       | High          |
| **Session memory (12 sections)** | Structured live notes: files, workflow, errors, learnings  | Session files are append-only daily notes       | High — structured notes survive compaction better            | Medium        |
| **Auto-dream consolidation**     | Scheduled background with gate chain, lock, phases         | consolidateMemory() exists but is manual-only   | Medium — auto consolidation keeps memory fresh               | Medium        |
| **Team memory sync**             | Server-synced, org-wide, per-repo, secret-scanned          | No team memory (single-tenant focus)            | Low for now (KairoClaw is self-hosted, not org-wide)         | High          |
| **Relevant memory selection**    | Sonnet selects top 5 per turn (LLM-based relevance)        | Load all profile + last 3 days (brute force)    | Medium — relevant selection scales better with large memory  | Medium        |
| **Secret scanning**              | 40+ gitleaks rules before memory writes                    | No secret scanning in memory                    | High — users might accidentally store API keys               | Low           |
| **Memory in compaction**         | Session memory used AS compaction summary                  | Memory and compaction are independent systems   | Medium — using memory as compaction input is more coherent   | Medium        |
| **Trust boundaries**             | Managed > User > Project > Local priority                  | Admin > User role, scoped dirs                  | Low — KairoClaw's multi-user RBAC covers most cases          | Low           |
| **What NOT to save**             | Explicit exclusion list in prompt                          | No guidance on what to exclude                  | Low — easy prompt addition                                   | Low           |
| **Memory freshness checking**    | Verify memory still valid before recommending              | No freshness check — memory could be stale      | Medium — stale memory leads to wrong recommendations         | Low           |


### What KairoClaw has that Claude Code doesn't


| Feature                         | KairoClaw                                            | Claude Code                                   |
| ------------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| **Multi-user memory isolation** | Per-user scoped directories, SQL-filtered search     | Single-user (no isolation needed)             |
| **Multi-channel memory**        | Same user, different channels → unified memory       | Terminal only                                 |
| **Chunked vector-like search**  | SQL-indexed chunks with keyword scoring              | File-based discovery, LLM relevance selection |
| **Scope migration**             | Auto-migrate when user gets UUID (channel:id → UUID) | N/A                                           |
| **Database-backed index**       | memory_chunks table with SQL queries                 | Filesystem-only                               |


---

## 4. Recommended Improvements (Priority Order)

### Quick Wins (Low effort, high impact)

**A. Add "What NOT to save" to system prompt**

```
- Don't save code patterns or file paths (derive from code)
- Don't save git history (use git log)
- Don't save debugging solutions (fix is in the code)
- Don't save ephemeral task details
```

Just a prompt addition — 5 minutes.

**B. Add memory freshness guidance to system prompt**

```
Before recommending from memory:
- If memory names a file path: verify it exists
- If memory names a function: grep for it
- Memory is a claim about the past, not a guarantee about now
```

Prompt addition — 5 minutes.

**C. Secret scanning on memory writes**
Add basic pattern matching before writing to PROFILE.md:

- `sk-ant-`*, `sk-*`, `ghp_*`, `AKIA*`, `Bearer *`
- Strip or warn if detected
~30 lines of code.

**D. Memory index (MEMORY.md)**
Create a MEMORY.md in each scope that lists what the profile contains:

```markdown
- User prefers concise responses
- Works in real estate, Dubai Marina
- Primary language: Arabic + English
```

Updated by consolidateMemory(). Model reads this first before loading full profile.
~20 lines.

### Medium Effort (Worth doing)

**E. Auto-dream scheduling**
Wire `consolidateMemory()` to run automatically:

- Gate: 24h since last run + 5+ sessions
- Already have the function — just need the trigger
~50 lines.

**F. Structured session memory**
Instead of append-only daily notes, use sections:

```markdown
## Current Task
## Key Files
## Decisions Made
## Open Questions
```

Updated each session instead of appended. Better for compaction.
~100 lines.

**G. Typed memory categories**
Add frontmatter to memory files:

```markdown
---
type: feedback
---
User prefers bullet points over paragraphs
```

Extraction prompt asks for type classification. Search can filter by type.
~80 lines + prompt changes.

### Later (High effort or low immediate value)

**H. LLM-based relevance selection** — Use Haiku to pick top 5 memories per turn instead of loading everything. Matters when memory grows large.

**I. Forked subagent extraction** — Run memory extraction as a subagent sharing parent cache. Requires subagent infrastructure improvements first.

**J. Team memory sync** — Server-side memory sharing. Only needed when KairoClaw goes multi-tenant / org-wide.

---

## 5. Architecture Comparison Diagram

```
KAIROCLAW (Current)                    CLAUDE CODE
─────────────────                      ──────────
Startup:                               Startup:
  Index .md → memory_chunks DB           Discover CLAUDE.md files (4 layers)
  File watchers for changes              Load MEMORY.md index
                                         Init extraction/dream/session closures

Per-Turn:                              Per-Turn:
  Load PROFILE.md (3K chars)             Load memory prompt instructions
  Load last 3 sessions (4.5K chars)      Sonnet selects top 5 relevant memories
  Total: ~7.5K chars in prompt           CLAUDE.md files as user context
                                         Session memory as compaction summary

Post-Turn:                             Post-Turn:
  LLM extracts facts (inline call)       Fork subagent extracts memories
  Append to sessions/YYYY-MM-DD.md       Session memory updated (12 sections)
  Clean up >7 day files                  Cursor advanced past processed messages

Consolidation:                         Consolidation:
  Manual trigger only                    Auto-dream (24h + 5 sessions gate)
  Merge sessions → PROFILE.md            Orient → Gather → Consolidate → Prune
                                         Lock-based coordination

Search:                                Search:
  SQL chunks + keyword scoring           File discovery + LLM relevance
  Scoped per user                        Per-project scope

Team:                                  Team:
  N/A (single-tenant)                    Server-synced, org-wide
                                         Secret scanning (40+ rules)
```

