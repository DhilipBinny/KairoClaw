# Claude Code Design Patterns → KairoClaw Adoption Guide

Deep analysis of Claude Code's source architecture and what KairoClaw can adopt.

---

## 1. TOOL SYSTEM — Declarative `buildTool` Factory

**Claude Code pattern:** Every tool is a declarative object with ~30 optional methods, built via `buildTool()` which fills security-safe defaults (fail-closed).

```typescript
// Claude Code: tools are objects with schema + behavior + rendering
const FileEditTool = buildTool({
  name: 'FileEdit',
  inputSchema: zodSchema,
  call(input, context) { ... },
  checkPermissions(input, context) { ... },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,    // conservative default
  prompt(options) { ... },            // LLM-facing description
  renderToolUseMessage(input) { ... },// UI rendering
  maxResultSizeChars: 100_000,
})
```

**KairoClaw today:** Tools are simpler objects in `tools/builtin/` with `{ name, description, parameters, execute }`. No permission hooks on the tool itself, no concurrency flags, no LLM-specific prompt methods.

**What to adopt:**
- Add `checkPermissions()` to each tool definition (instead of only checking in registry)
- Add `isReadOnly` / `isDestructive` / `isConcurrencySafe` flags — this enables **parallel tool execution** (see #3)
- Add `prompt()` method so each tool can describe itself differently based on context (model capabilities, user role)
- Use `maxResultSizeChars` per tool to auto-truncate output before it hits context

---

## 2. CONTEXT COMPACTION — Multi-Tier Strategy

**Claude Code pattern:** Three tiers of context reduction:

| Tier | Trigger | Action |
|------|---------|--------|
| Auto-compact | tokens > (contextWindow - 13K) | Summarize old turns via LLM |
| Reactive compact | API returns "prompt too long" | Strip images, peel message groups |
| Post-compact restore | After any compaction | Re-inject last 5 edited files + active skills |

**KairoClaw today:** Has soft clean (strip old tool results at 50%) + hard compact (LLM summary at 75%). Good foundation.

**What to adopt:**
- **Reactive compact** — catch "prompt too long" API errors and auto-recover instead of failing. Claude Code strips images first (cheap), then peels message groups
- **Post-compact file restoration** — after compacting, re-inject the most recently edited files (up to 50K tokens). This prevents the "forgot what file we were editing" problem
- **Circuit breaker** — Claude Code limits consecutive compact failures to 3, then gives up. Prevents infinite compact→fail loops
- **Token budget per tool output** — 10KB per tool, 30KB per round. KairoClaw has this (10KB/tool, 30KB/round) — good, keep it

---

## 3. PARALLEL TOOL EXECUTION

**Claude Code pattern:** Tools that declare `isConcurrencySafe: true` (like Read, Glob, Grep) execute in parallel. Others run sequentially.

```typescript
// Claude Code: fork-join for safe tools
for (const toolUse of toolUseBlocks) {
  if (tool.isConcurrencySafe(toolUse.input)) {
    concurrentResults[id] = tool.call(...)  // fire
  } else {
    yield await tool.call(...)              // wait
  }
}
// then await all concurrent results
```

**KairoClaw today:** Sequential tool execution only.

**What to adopt:** Add `isConcurrencySafe` flag to tools:

| Safe (parallel OK) | Unsafe (sequential) |
|---|---|
| `file_read`, `file_list` | `file_write`, `file_edit`, `file_delete` |
| `web_search`, `web_fetch` | `shell_exec` |
| `memory_search`, `pdf_read` | `memory_write`, `memory_consolidate` |
| `plugin_call` (read-only) | `send_telegram`, `send_whatsapp`, `send_email` |

Execute safe tools with `Promise.all()` — can cut multi-tool rounds from 5s to 1s.

---

## 4. GENERATOR-BASED STREAMING LOOP

**Claude Code pattern:** The query loop is an `async function*` generator that yields events:

```typescript
async function* query(params): AsyncGenerator<StreamEvent> {
  // ...build context...
  const stream = queryModel(...)
  yield* streamAssistantMessage(stream)   // yields chunks
  yield* runTools(toolBlocks)             // yields progress + results
  if (needsMoreTurns) yield* query(...)   // recursive
}
```

This gives the caller full control — they can cancel, throttle, or transform events.

**KairoClaw today:** The agent loop in `loop.ts` is a `while` loop that streams text via WebSocket callbacks.

**What to adopt:** Refactor the agent loop to yield events. Benefits:
- Channel-agnostic streaming (Telegram, WhatsApp, Web all consume the same generator)
- Easier to add progress indicators for tool execution
- Enables cancellation via `generator.return()`
- Makes testing trivial (collect events into array)

---

## 5. PROMPT CACHE OPTIMIZATION

**Claude Code pattern:** System prompt split into **cached** (static) and **dynamic** (per-session) sections with an explicit boundary marker:

```typescript
// Static section (cached across requests — saves $$)
sections.push(mainPrompt)        // 10KB+
sections.push(toolDescriptions)  // 5KB+
sections.push('__CACHE_BOUNDARY__')

// Dynamic section (per-session, NOT cached)
sections.push(userContext)       // CWD, OS, model
sections.push(permissionMode)   // current settings
```

**KairoClaw today:** System prompt built fresh each call from persona files + memory + tool definitions.

**What to adopt:** Split your prompt builder to put stable content (persona, tool definitions, rules) before volatile content (memory, session context). Anthropic's prompt caching charges 90% less for cache hits on the static prefix. For a 10K-token system prompt, this saves ~$0.027 per request at Opus prices.

---

## 6. DEFERRED TOOL LOADING (ToolSearch)

**Claude Code pattern:** With 44+ tools, loading all tool schemas into the system prompt wastes tokens. Instead, only tool *names* are listed, and the model calls `ToolSearch` to fetch full schemas on demand.

**KairoClaw today:** All 20 tool definitions always included in system prompt.

**What to adopt:** As your tool count grows (especially with MCP + plugins), implement deferred loading. Only include the 5-8 most common tools in the prompt, and let the model discover others via a search tool. This can save 3-5K tokens per request.

---

## 7. PERMISSION RULE ENGINE

**Claude Code pattern:** Multi-source rules with priority: `allow → deny → ask`, loaded from policies files + session rules + user decisions. Decisions can be persisted ("always allow git commands").

```typescript
// Rule evaluation order:
if (matchesRule(alwaysAllowRules, pattern)) return 'allow'
if (matchesRule(alwaysDenyRules, pattern))  return 'deny'
if (matchesRule(alwaysAskRules, pattern))   return 'ask'
// fallback to mode (bypass / auto / default)
```

**KairoClaw today:** Role-based tool filtering (admin/power/user) at registry level.

**What to adopt:** Add **per-tool pattern matching** on top of RBAC. Examples:
- Allow `shell_exec` for user X but only `git *` and `npm *` commands
- Allow `file_write` but deny writes to `*.env` or `/etc/*`
- This is especially powerful for the `shell_exec` tool where blanket allow/deny is too coarse

---

## 8. SUBAGENT CONTEXT ISOLATION

**Claude Code pattern:** When spawning a subagent, state is **cloned** (not shared). Subagent gets its own token budget, denial tracking, and file state cache. But certain resources are shared (MCP clients, tool definitions).

```typescript
const subCtx = {
  ...parentCtx,
  readFileState: clone(parentCtx.readFileState),  // isolated
  setAppState: () => {},                           // no-op (can't affect parent)
  agentId: newId(),                                // separate tracking
  // shared: tools, MCP clients, models
}
```

**KairoClaw today:** `subagent-registry.ts` tracks nested agents with depth limits (max 3). Good foundation.

**What to adopt:**
- Clone mutable state per subagent (file cache, tool results) to prevent races
- Give each subagent a separate token/cost budget so a runaway subagent can't burn the parent's context
- Use `no-op setAppState` so subagent side-effects don't leak to parent

---

## 9. REACTIVE ERROR RECOVERY

**Claude Code pattern:** Errors are classified into types with specific recovery actions:

| Error | Recovery |
|-------|----------|
| 429 (rate limit) | Exponential backoff with jitter |
| 529 (overloaded) | Retry with longer backoff, max N retries |
| "prompt too long" | Trigger reactive compact, retry |
| Connection reset | Retry immediately (stale connection) |
| 401 (auth) | Re-auth flow |

**KairoClaw today:** Provider registry has failover (primary → fallback) + exponential backoff with jitter.

**What to adopt:**
- **"Prompt too long" recovery** — instead of failing, auto-compact and retry. Critical for long sessions
- **Persistent retry mode** for background/unattended runs (cron jobs) — keep retrying indefinitely with heartbeat pings instead of failing after N attempts
- **Error classification function** — centralize error → recovery-action mapping instead of ad-hoc try/catch

---

## 10. POST-COMPACT FILE RESTORATION

**Claude Code pattern:** After compacting, re-read the last 5 edited files (up to 5K tokens each, 50K total budget) and inject them as context. Also restores active skills.

```typescript
const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
const POST_COMPACT_TOKEN_BUDGET = 50_000
const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
```

**KairoClaw today:** No post-compact restoration.

**What to adopt:** Track which files the agent edited during the session. After hard compaction, re-inject the most recent ones. This prevents the common failure mode where the agent forgets the file it was actively editing after a compaction event.

---

## 11. MICROCOMPACT — Surgical Tool Result Pruning

**Claude Code pattern:** Two-tier tool result cleanup that preserves the API prompt cache:

| Tier | When | Action |
|------|------|--------|
| Cache-aware (warm) | Cache still valid (<5min) | Use `cache_edits` API to delete old results without invalidating cached prefix |
| Time-based (cold) | Gap >60min since last message | Content-clear old tool results, keep only 5 most recent |

```typescript
// Phase 1: Track which tool results are compactable (Read, Bash, Grep, etc.)
const compactableToolIds = new Set(collectCompactableToolIds(messages))

// Phase 2: On trigger, replace old tool result content with ""
// Keep the message structure intact (tool_use_id still matches)
// API sees: tool_result with empty content → much smaller prompt

// Phase 3: Time-based trigger (session idle >60min)
if (minutesSinceLastAssistant > 60) {
  // Cache has expired anyway — clear old results to shrink rewrite
  keepOnlyRecentToolResults(messages, keepRecent: 5)
}
```

**KairoClaw today:** Soft compaction strips tool results at 50% threshold, but always rewrites all messages.

**What to adopt:**
- Track which tools produce compactable output (read-only tools like `file_read`, `web_fetch`, `memory_search`)
- On soft compaction, replace old tool result *content* with `"[result cleared]"` instead of removing entire messages — preserves conversation structure
- Add time-based trigger: if session is idle >60min, proactively clear old tool results before next LLM call
- Keeps the conversation history intact for audit/display while reducing token count

---

## 12. API-ROUND MESSAGE GROUPING

**Claude Code pattern:** When compacting, messages are grouped by **API round** (assistant message.id boundaries), not by user turns.

```typescript
// Problem: In agentic sessions, there's often ONE user message and 20+ rounds
// of assistant→tool_use→tool_result. Grouping by "user turn" = useless.

// Solution: Group by assistant response boundaries
groupMessagesByApiRound(messages) {
  // Split when a NEW assistant message.id appears
  // Each group = one LLM call + its tool results
  // = safe to drop as a unit (no orphaned tool_use blocks)
}
```

**KairoClaw today:** Compaction works on individual messages, which can leave orphaned tool_use/tool_result pairs.

**What to adopt:**
- Before compaction, group messages into rounds: `[assistant + its tool_results]`
- When removing old context, always remove complete rounds (never split a tool_use from its tool_result)
- This prevents API errors from malformed message sequences after compaction

---

## 13. SCRATCHPAD PATTERN IN COMPACTION PROMPTS

**Claude Code pattern:** Compaction prompts use `<analysis>` XML tags as a reasoning scratchpad that gets stripped from the final output:

```typescript
// In the compaction system prompt:
"Before providing your final summary, wrap your analysis in <analysis> tags
to organize your thoughts:
1. Chronologically analyze each message...
2. Double-check for technical accuracy..."

// After LLM returns:
formattedSummary = formattedSummary.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
```

**Compaction summary structure (from Claude Code):**
```markdown
## Active Tasks
- [current objectives the agent should continue working on]

## Resolved Topics
- [completed work — historical record only]

## Key Facts
- [reference data: file paths, decisions made, constraints discovered]

## Current Work
- [what was happening right before compaction, with direct quotes]
```

**KairoClaw today:** Hard compaction prompt asks for Active Tasks / Resolved Topics / Key Facts. Good — matches Claude Code structure.

**What to adopt:**
- Add `<analysis>` scratchpad instruction to the compaction prompt — improves summary quality significantly
- Strip `<analysis>` tags from the LLM output before storing
- Add a "Current Work" section with direct quotes from recent messages
- Add guidance: "Resolved Topics are historical ONLY — do NOT revisit unless user asks"

---

## 14. AUTO-DREAM — Background Memory Consolidation

**Claude Code pattern:** A scheduled background agent that synthesizes learnings from past sessions into persistent memory files. Uses a **cheapest-first gate chain** to avoid wasted work:

```
Gate 1: Time gate     — hoursSince(lastConsolidated) >= 24h?     [free check]
Gate 2: Scan throttle — lastScan > 10min ago?                    [free check]
Gate 3: Session gate  — sessionsTouched >= 5 since last?         [file scan]
Gate 4: Lock gate     — no other process consolidating?          [file lock]
→ Only then: spawn background agent with FILE_EDIT/FILE_WRITE only
```

**KairoClaw today:** `auto-memory.ts` has `consolidateMemory()` that merges session files into PROFILE.md, but it's only called manually and has no gating/scheduling.

**What to adopt:**
- Add a lightweight gating chain before `consolidateMemory()` runs — check time elapsed + session count before doing LLM work
- Schedule consolidation to run after agent turns complete (fire-and-forget, like `autoSummarizeToMemory` already does)
- Add a file-based lock to prevent concurrent consolidation across channels
- Limit the consolidation agent's tools (only memory read/write, no shell_exec)
- Track `lastConsolidatedAt` timestamp per scope

---

## 15. PROMPT CACHE BREAK DETECTION

**Claude Code pattern:** Multi-dimensional state hashing to detect **silent** cache misses (cache misses that don't cause errors but waste money):

```typescript
// Pre-call: snapshot the state
recordPromptState({
  systemHash,          // hash of system prompt (stripped of cache_control)
  toolsHash,           // hash of tool schemas
  cacheControlHash,    // hash of cache_control markers
  model, effortValue, betas, extraBodyParams
})

// Post-call: check API response
checkResponseForCacheBreak(cacheReadTokens, cacheCreationTokens) {
  // If cache_read dropped >5% AND delta > 2K tokens
  // AND not a TTL expiry (check message timestamps for >5min gap)
  // → log cache break warning with reason (tool schema changed? model switched?)
}
```

**KairoClaw today:** No cache monitoring.

**What to adopt:**
- Track `cache_creation_input_tokens` and `cache_read_input_tokens` from Anthropic API responses (they're in `message_start` events)
- Log when cache reads drop significantly between consecutive calls in the same session
- Compare system prompt hash between calls — if it changed, that's why the cache broke
- Useful for debugging cost spikes: "why did this session cost 5x more?"

---

## 16. FORKED AGENT CACHE SHARING

**Claude Code pattern:** Sub-agents (prompt suggestions, summaries, background tasks) reuse the **parent's prompt cache** by sending identical cache-key parameters:

```typescript
// Parent request: model + system prompt + tools → creates cache
// Child fork: SAME model + SAME system prompt + SAME tools → cache HIT

runForkedAgent({
  cacheSafeParams: createCacheSafeParams(parentContext),  // identical to parent
  canUseTool: async () => ({ behavior: 'deny' }),         // tools sent but denied
  // DON'T override: maxOutputTokens, effort, thinking (would bust cache)
})
```

**Key insight:** Tools are included in the API request for cache-key matching, but denied via callback. The model sees the tools but can't use them — and the cache hits.

**KairoClaw today:** Subagents are fully independent sessions with separate LLM calls.

**What to adopt:**
- When spawning a subagent, pass the same `systemPrompt` and `tools` array as the parent
- The subagent's actual tool access is controlled by the executor, not the prompt
- This means the first subagent call in a session gets a cache hit on the parent's prefix — saves ~90% on a 10K+ system prompt

---

## 17. PROMPT ENGINEERING TECHNIQUES

**Claude Code uses several prompt patterns worth adopting in KairoClaw's `buildSystemPrompt()`:**

### a) Feature-Gated Prompt Sections
```typescript
// Different prompt sections based on runtime context
const autonomousSection = config.agent.autonomous ? AUTONOMOUS_RULES : COLLABORATIVE_RULES
sections.push(autonomousSection)
```
**Adopt:** Add per-channel prompt variants (Telegram gets shorter prompts, Web gets full context).

### b) Few-Shot Good/Bad Examples
```
Good: "Saved the report to documents/q4-summary.md"
Bad: "I have completed the task as requested" (too vague)
Bad: "Here is the file..." (don't narrate, just do it)
```
**Adopt:** Add examples to tool usage guidance in the system prompt.

### c) Explicit Parallelization Hints
```
1. Run these tools in parallel:
   - file_read("config.json")
   - file_read("package.json")
2. Then sequentially:
   - file_write("merged.json", ...)
   Note: write depends on both reads completing.
```
**Adopt:** If you implement parallel tool execution (#3), add guidance telling the model which tools can be batched.

### d) Turn Budget Awareness
```
"You have a limited turn budget. Turn 1 — issue all reads in parallel;
Turn 2 — issue all writes in parallel. Do not interleave."
```
**Adopt:** Add to subagent prompts (they have `maxToolRounds` limit).

### e) Modular System Prompt as Array
```typescript
// Instead of string concatenation:
const sections: string[] = []
sections.push(identity)
sections.push(tools)
sections.push(safety)
// Each section independently testable and cacheable
return sections.join('\n\n')
```
**Adopt:** KairoClaw already does this — good.

---

## 18. PROVIDER CIRCUIT BREAKER

**Claude Code pattern:** After N consecutive failures from a provider, stop trying it for a cooldown period instead of failing every request:

**KairoClaw today:** Provider failover retries on every call, even if the provider has been failing for 10 minutes straight.

**What to adopt:**
- Track consecutive failures per provider
- After 3 consecutive failures, mark provider as "open circuit" for 5 minutes
- During open circuit: skip directly to fallback, no wasted latency
- After cooldown: try one "probe" request — if it succeeds, close circuit
- Log circuit state changes for observability

---

## 19. TOOL ARGUMENT VALIDATION

**Claude Code pattern:** Every tool validates input against a Zod schema *before* execution. Invalid input returns a structured error to the LLM (not a crash).

**KairoClaw today:** Tool arguments are passed directly to executor with no schema validation. Malformed args can cause runtime errors.

**What to adopt:**
- Add Zod schemas to tool definitions (you already have `parameters` as JSON Schema — can derive Zod from it)
- Validate before calling `executeTool()` in the agent loop
- Return clean error message to LLM: `"Invalid argument 'path': expected string, got number"`
- This helps the model self-correct on the next round instead of getting opaque stack traces

---

## Implementation Progress

| # | Feature | Effort | Status |
|---|---------|--------|--------|
| ~~1~~ | ~~Prompt cache boundary~~ | ~~Low~~ | **Merged** |
| ~~2~~ | ~~Parallel tool execution~~ | ~~Medium~~ | **Merged** |
| ~~3~~ | ~~Reactive compact (prompt-too-long recovery)~~ | ~~Medium~~ | **Merged** |
| ~~4~~ | ~~Post-compact file restoration~~ | ~~Low~~ | **Merged** |
| ~~5~~ | ~~API-round message grouping~~ | ~~Low~~ | **Merged** |
| ~~6~~ | ~~Scratchpad in compaction prompts~~ | ~~Low~~ | **Merged** |
| ~~7~~ | ~~Tool argument validation~~ | ~~Low~~ | **Merged** |
| ~~8~~ | ~~Provider circuit breaker~~ | ~~Low~~ | **Skipped** (single provider most setups) |
| ~~9~~ | ~~Prompt engineering techniques~~ | ~~Low~~ | **PR #9 open** |
| ~~10~~ | ~~Per-tool permission patterns~~ | ~~Medium~~ | **Skipped** (existing RBAC sufficient) |
| ~~11~~ | ~~Error classification engine~~ | ~~Medium~~ | **PR #10 open** |

## Remaining — Priority Order

### Skills (in progress)

| Rank | # | Feature | Effort | Relevance | Why |
|------|---|---------|--------|-----------|-----|
| **1** | **19-21** | **Skill system (loader + tools + slash + admin UI + bundled)** | Medium | 10/10 | **PR #11 open** — full skill system with create_skill tool, 6 bundled skills, admin page |

### Memory Improvements (from Claude Code comparison — see `docs/MEMORY-ARCHITECTURE-COMPARISON.md`)

| Rank | # | Feature | Effort | Relevance | Why |
|------|---|---------|--------|-----------|-----|
| **2** | 22 | Memory prompt guidance — "what NOT to save" + freshness checks | Low | 8/10 | Prevents junk/stale memory. Just prompt additions. 5 min. |
| **3** | 23 | Secret scanning on memory writes | Low | 9/10 | Users might accidentally store API keys in PROFILE.md. Basic regex patterns. |
| **4** | 24 | Auto-dream scheduling — wire consolidateMemory() to run automatically | Medium | 9/10 | Gate: 24h + 5 sessions. Memory stays fresh across days without manual trigger. |
| **5** | 25 | Structured session memory — sections instead of append-only | Medium | 8/10 | Sections (Current Task, Key Files, Decisions, Open Questions) survive compaction better. |
| **6** | 26 | Memory index (MEMORY.md) — central map of what's stored | Low | 7/10 | Model reads index first before loading full profile. Better navigation. |
| **7** | 27 | Typed memory categories — user/feedback/project/reference frontmatter | Medium | 7/10 | More searchable, more maintainable. Extraction prompt classifies by type. |
| **8** | 28 | LLM-based relevant memory selection — pick top 5 per turn | Medium | 6/10 | Scales better than loading everything. Matters when memory grows large. |

### Existing items

| Rank | # | Feature | Effort | Relevance | Why |
|------|---|---------|--------|-----------|-----|
| **9** | 13 | Auto-dream (background consolidation) | Medium | 9/10 | Superseded by #24 above — same feature, now scoped properly. |
| **10** | 14 | Subagent context isolation | Medium | 8/10 | Prevent state leaks in multi-agent. |
| **11** | 12 | Microcompact (time-based pruning) | Medium | 7/10 | Token savings on idle Telegram/WhatsApp sessions. |
| **12** | 15 | Cache break detection | Medium | 5/10 | Cost monitoring for API key users. |
| **13** | 16 | Deferred tool loading | Medium | 4/10 | Future-proofing for 30+ tools. |
| **14** | 17 | Forked agent cache sharing | Medium | 4/10 | Subagent optimization. |
| **15** | 18 | Generator-based agent loop | High | 3/10 | Major rewrite. Save for v2. |
