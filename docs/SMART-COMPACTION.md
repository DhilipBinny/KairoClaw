# Smart Context Compaction

> Structured, two-stage compaction that prevents cross-topic pollution and reduces token waste.
>
> Branch: `feature/smart-compaction` | Status: Implemented

---

## The Problem

Current compaction summarizes **everything into one flat blob**. The agent can't distinguish resolved topics from active work. This causes:

1. **Cross-topic pollution** — Agent references old bugs/tasks that are already resolved
2. **Hallucination from stale context** — After compaction, the summary mentions an old topic and the agent treats it as current
3. **Token waste** — Tool results (often 80%+ of tokens) are preserved verbatim until hard compaction

### Real Example

A 146-message Telegram session about browsing Amazon. After compaction, the summary mentioned an early "tool not found" error. The agent then **hallucinated about that error for 20+ messages** instead of calling the browse tool — because the flat summary gave equal weight to resolved and active topics.

---

## The Solution: Three Changes

```
┌─────────────────────────────────────────────────────────┐
│                    CONTEXT WINDOW                        │
│                                                          │
│  0%          50%              75%              100%      │
│  ├───────────┼────────────────┼────────────────┤        │
│              │                │                          │
│              ▼                ▼                          │
│         SOFT CLEAN       HARD COMPACT                   │
│      (strip tool results)  (LLM summary)                │
│      No LLM call needed   Structured output              │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Change 1: Structured Summary with Topic Status

**Before** — flat summary:
```
The user asked about browsing Amazon. The browse tool was not found initially.
Then the tool was enabled and the user browsed product pages. The agent also
discussed a Telegram bot menu update...
```

**After** — structured summary with sections:
```
## Active Tasks
- User is browsing Amazon product pages via browse tool
- Looking for specific laptop deals under $800

## Resolved Topics
- Browse tool was initially missing from permissions → FIXED (added to power_user)
- Telegram bot menu updated with /new, /status, /compact → DEPLOYED

## Key Facts
- User's Telegram ID: 123456
- Session channel: telegram
- Model: claude-sonnet-4-5-20250514
- Browse tool enabled, extension connected
```

**Why this helps:** The system prompt tells the agent to deprioritize `## Resolved Topics`. The agent focuses on `## Active Tasks` and uses `## Key Facts` as reference. No more hallucinating about fixed bugs.

### Change 2: Tool Result Eviction (Pre-processing)

Before the LLM summarizes, we strip old tool results down to one line:

```
┌──────────────────────────────────────────────────┐
│ BEFORE (tool result message, ~2000 tokens):      │
│                                                    │
│ [Tool: web_fetch]                                 │
│ <!DOCTYPE html><html><head><title>Amazon...       │
│ ... 8KB of HTML content ...                       │
│ </div></body></html>                              │
└──────────────────────────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────┐
│ AFTER (evicted, ~20 tokens):                     │
│                                                    │
│ [Tool result: web_fetch] <!DOCTYPE html><html>... │
└──────────────────────────────────────────────────┘
```

**Rules:**
- Only evict tool results from the "older" portion (not recent messages)
- Keep the tool name + first line (up to 200 chars) for context
- This runs **before** the LLM summarization call, so the LLM sees cleaner input
- Reduces input to summarizer by ~60-80%

### Change 3: Two-Stage Compaction

```
         Messages accumulate over time
         ─────────────────────────────►

  Stage 0          Stage 1              Stage 2
  (normal)      (soft clean)        (hard compact)
     │               │                    │
     │    50% of     │     75% of        │
     │    context    │     context       │
     │    window     │     window        │
     ▼               ▼                    ▼
┌─────────┐   ┌──────────┐       ┌──────────────┐
│ No       │   │ Strip    │       │ LLM          │
│ action   │   │ old tool │       │ structured   │
│          │   │ results  │       │ summary      │
│          │   │ in-place │       │              │
│          │   │          │       │ Delete old   │
│          │   │ No LLM   │       │ messages,    │
│          │   │ call     │       │ insert       │
│          │   │          │       │ summary      │
│          │   │ ~40-60%  │       │              │
│          │   │ savings  │       │ ~80-90%      │
│          │   │          │       │ savings      │
└─────────┘   └──────────┘       └──────────────┘
```

**Stage 1 — Soft Clean (50% threshold):**
- No LLM call (fast, free)
- Walk older messages, replace tool result content with one-line stub
- Update messages in-place in the database
- Typically saves 40-60% of token usage
- Idempotent: re-running skips already-evicted messages (content already ≤200 chars)

**Stage 2 — Hard Compact (75% threshold):**
- Full LLM summarization (existing behavior, improved)
- Uses the structured prompt from Change 1
- Deletes old messages, inserts structured summary as system message

---

## System Prompt Guidance

After compaction, the system prompt includes:

```
Your conversation context has been compacted. The [Context Summary] message
contains a structured summary of earlier conversation. Follow these rules:
- Focus on items under "## Active Tasks" — these are your current objectives
- Treat "## Resolved Topics" as historical record only — do NOT revisit or
  re-investigate these unless the user explicitly asks
- Use "## Key Facts" as reference data
- If unsure whether something is still relevant, ask the user or use tools
  to verify current state — do NOT assume from the summary
```

---

## Configuration

All thresholds are configurable in `config.agent`:

| Setting | Default | Description |
|---------|---------|-------------|
| `compactionThreshold` | `0.75` | Hard compaction trigger (% of context window) |
| `softCompactionThreshold` | `0.50` | Soft clean trigger (% of context window) |
| `keepRecentMessages` | `10` | Messages to preserve during hard compaction |

---

## Flow Diagram

```
  checkAndCompact(sessionId, model, db, config, callLLM)
          │
          ▼
  ┌─ estimateMessageTokens() ─┐
  │  Calculate current usage    │
  └────────────┬───────────────┘
               │
               ▼
       tokens < 50% ──── YES ──── return (no action)
               │
               NO
               │
               ▼
    tokens 50-75% ──── YES ──── softCompact()
               │                    │
               NO                   ├─ Walk older messages
               │                    ├─ Strip tool results to one-line
               │                    ├─ Update in DB (no delete)
               │                    └─ return { compacted: true, method: 'soft-clean' }
               │
               ▼
       tokens > 75% ──── YES ──── hardCompact()
                                    │
                                    ├─ Evict tool results from olderMessages
                                    ├─ summarizeWithLLM() [structured prompt]
                                    ├─ Delete old messages in transaction
                                    ├─ Insert structured summary as system msg
                                    ├─ Re-insert recent messages
                                    └─ return { compacted: true, method: 'llm-summary' }
```

---

## Files Modified

| File | Change |
|------|--------|
| `packages/core/src/agent/compaction.ts` | All three changes + new `softCompact()` + `evictToolResults()` functions |
| `packages/core/src/agent/prompt.ts` | Add compacted-context guidance to system prompt |
| `packages/core/src/agent/slash-commands.ts` | `/compact` output shows method label |
| `packages/core/src/db/repositories/message.ts` | New `updateContent()` method for soft compaction |
| `packages/types/src/config.ts` | `softCompactionThreshold` field in AgentConfig |
| `packages/core/src/config/schema.ts` | Zod schema + default (0.50) |
| `packages/core/src/routes/config.ts` | Admin allowlist for new setting |
| `docs/SMART-COMPACTION.md` | This document |
| `docs/PRODUCT_FEATURES.md` | Update compaction description |

---

## Before / After Comparison

### Token usage over a 100-message session:

```
Tokens
  ▲
  │
  │     Current (no soft clean)
  │     ╱╲
  │    ╱  ╲         ╱╲
  │   ╱    ╲       ╱  ╲
  │  ╱      ╲     ╱    ╲        Sawtooth — big drops,
  │ ╱        ╲   ╱      ╲       high peaks hit limits
  │╱          ╲ ╱        ╲
  ├──────────────────────────►  Messages
  │
  │     Smart compaction
  │        ___
  │      ╱    ╲___
  │    ╱           ╲___          Smoother — soft cleans
  │   ╱                ╲___      keep usage lower,
  │  ╱                      ╲    hard compacts less often
  │ ╱
  ├──────────────────────────►  Messages
```

### Summary quality:

| Aspect | Before | After |
|--------|--------|-------|
| Topic status | All mixed together | Separated: Active / Resolved / Facts |
| Resolved bugs | Referenced as if current | Clearly marked, agent ignores |
| Token waste | Tool results in full | Stripped before summarization |
| LLM calls | Every compaction | Only at 75% (50% is free) |
| Recovery from hallucination | Requires /new session | Agent self-corrects from structure |
