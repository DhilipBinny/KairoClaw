# Intelligent Model Routing & Context Layers — Full Analysis

Deep analysis of cost savings, strategy comparison, and user flow visualization for KairoClaw's model routing system.

---

## 1. Cost Per Model (Anthropic, as of 2026)

| Model | Input $/1M tokens | Output $/1M tokens | Context Window | Best for |
|-------|-------------------|--------------------|----|----------|
| **Haiku** | $0.80 | $4.00 | 200K | Simple tasks, classification, translation |
| **Sonnet** | $3.00 | $15.00 | 200K | Standard tasks, tool use, analysis |
| **Opus** | $15.00 | $75.00 | 1M | Complex reasoning, architecture, deep analysis |

**Ratio:** Opus is **19x** more expensive than Haiku on input, **19x** on output.

---

## 2. User Archetypes & Their Usage Patterns

### Type A: Casual User (shop owner, basic queries)
```
"What time do you open?"
"Do you have iPhone 16 in stock?"
"Send Ahmed a message"
"Translate this to Arabic"
```
- **90% Haiku-capable** tasks
- Average: 20 messages/day, 500 tokens/message
- Context rarely exceeds 20K tokens

### Type B: Power User (business manager, research + analysis)
```
"Research UAE real estate trends"
"Read these 5 reports and compare"
"Draft a business proposal"
"Summarize last week's sales data"
```
- **50% Haiku, 40% Sonnet, 10% Opus** split
- Average: 50 messages/day, 1000 tokens/message
- Context grows to 100-200K in research sessions

### Type C: Heavy User (developer, complex multi-file tasks)
```
"Read all files in this repo and analyze the architecture"
"Compare 3 codebases line by line"
"Design a new system based on everything we discussed"
```
- **20% Haiku, 40% Sonnet, 40% Opus** split
- Average: 100 messages/day, 2000 tokens/message
- Context regularly hits 200K-500K tokens

---

## 3. Cost Comparison: Current vs Routed

### Current Design (all Sonnet, all the time)

| User Type | Messages/day | Avg tokens/msg | Daily input tokens | Daily cost (Sonnet) | Monthly cost |
|-----------|-------------|----------------|-------------------|--------------------:|-------------:|
| **A (Casual)** | 20 | 500 | 10K | $0.03 | $0.90 |
| **B (Power)** | 50 | 1,000 | 50K | $0.15 | $4.50 |
| **C (Heavy)** | 100 | 2,000 | 200K | $0.60 | $18.00 |

*Note: includes input only. Output typically 2-3x less volume but higher per-token cost.*

### With Intelligent Router

**Type A (Casual) — 90% Haiku, 10% Sonnet:**

| Model | Messages | Tokens | Cost |
|-------|----------|--------|-----:|
| Haiku | 18 | 9K | $0.007 |
| Sonnet | 2 | 1K | $0.003 |
| **Total** | 20 | 10K | **$0.01** |
| **Savings vs all-Sonnet** | | | **67%** |

**Type B (Power) — 50% Haiku, 40% Sonnet, 10% Opus:**

| Model | Messages | Tokens | Cost |
|-------|----------|--------|-----:|
| Haiku | 25 | 12.5K | $0.010 |
| Sonnet | 20 | 20K | $0.060 |
| Opus | 5 | 17.5K | $0.263 |
| **Total** | 50 | 50K | **$0.333** |
| **Savings vs all-Sonnet** | | | **-122% (more expensive)** |

Wait — Opus costs more! But the **quality is better** on those 5 complex tasks. Let me recalculate with smarter routing where Opus is only used for truly complex work:

**Type B (revised) — 60% Haiku, 38% Sonnet, 2% Opus:**

| Model | Messages | Tokens | Cost |
|-------|----------|--------|-----:|
| Haiku | 30 | 15K | $0.012 |
| Sonnet | 19 | 19K | $0.057 |
| Opus | 1 | 16K | $0.240 |
| **Total** | 50 | 50K | **$0.309** |

Hmm, even one Opus call is expensive. The real savings come from **Haiku replacing Sonnet**, not from adding Opus:

**Type B (Haiku+Sonnet only) — 60% Haiku, 40% Sonnet:**

| Model | Messages | Tokens | Cost |
|-------|----------|--------|-----:|
| Haiku | 30 | 15K | $0.012 |
| Sonnet | 20 | 35K | $0.105 |
| **Total** | 50 | 50K | **$0.117** |
| **Savings vs all-Sonnet** | | | **22%** |

### Summary: Cost Impact by User Type

| User Type | All-Sonnet/month | Routed/month | Savings | Strategy |
|-----------|------------------:|-------------:|--------:|----------|
| **A (Casual)** | $0.90 | **$0.30** | **67%** | Route most to Haiku |
| **B (Power)** | $4.50 | **$3.51** | **22%** | Haiku for simple, Sonnet for tools, Opus rarely |
| **C (Heavy)** | $18.00 | **$15.60** | **13%** | Less savings — most tasks actually need Sonnet/Opus |

**Key insight:** The biggest savings are for **casual users** (your SME target market). A shop owner mostly asks simple questions — routing to Haiku saves 67%.

---

## 4. The Real Value: Quality, Not Just Cost

Cost savings are good, but the bigger win is **quality on complex tasks**:

| Without routing | With routing |
|---|---|
| Sonnet handles "design the system architecture" | **Opus** handles it — deeper reasoning, better output |
| Sonnet handles "translate hello to Arabic" | **Haiku** handles it — same quality, 4x cheaper |
| One-size-fits-all | Right tool for the job |

For UAE SME customers, this means:
- Simple WhatsApp questions → fast, cheap Haiku responses
- Complex business analysis → Opus-quality output when it matters
- Monthly bill stays low because most messages are simple

---

## 5. Context Layer Strategies Compared

### Strategy A: Eager (build all layers every turn)

```
After EVERY turn:
  Layer 4: append to DB (free)
  Layer 3: truncate old tool results (free, string op)
  Layer 2: summarize if >5 turns since last (Haiku call, ~$0.0005)
  Layer 1: update brief if >10 turns (Haiku call, ~$0.0002)
  Layer 0: update topic (free, rule-based)
```

| Pros | Cons |
|------|------|
| Any model switch is **instant** (layer already built) | Small ongoing cost per turn (~$0.0005) |
| No latency on downscale | Wasted work if model never switches |
| Layers always fresh | More code complexity |

**Cost per 100-turn session:** ~$0.01 (10 Haiku summary calls)
**Downscale latency:** 0ms (instant)

**Best for:** Sessions that frequently switch models (e.g., mixed simple/complex conversation).

### Strategy B: Lazy (build layers only when needed)

```
After EVERY turn:
  Layer 4: append to DB (free)
  Layer 0: update topic (free)
  Layers 1-3: NOT built

On model downscale (e.g., Opus → Haiku):
  Check: does Layer 1 exist? No → build from Layer 4 now
  One-time cost: ~$0.001 (Haiku summarization)
  Cache the result for future switches
```

| Pros | Cons |
|------|------|
| Zero overhead when model doesn't switch | **2-5 second delay** on first downscale (building layer) |
| Most sessions never switch → zero cost | Layer may be stale if built much later |
| Simplest to implement | Cache invalidation complexity |

**Cost per 100-turn session:** $0.00 if no switch, ~$0.002 on first switch
**Downscale latency:** 2-5 seconds (first time), 0ms (subsequent)

**Best for:** Sessions that mostly stay on one model (90%+ of sessions).

### Strategy C: Hybrid (keep cheap layers fresh, build expensive ones lazily)

```
After EVERY turn:
  Layer 4: append to DB (free)
  Layer 0: update topic (free, rule-based)
  Layer 1: update brief every 10 turns (Haiku, ~$0.0002)
  Layer 2-3: NOT built (lazy)

On downscale to Haiku:
  Use Layer 1 (already built) → instant ✅

On downscale to Sonnet (needs more detail):
  Check: does Layer 3 exist? No → build from Layer 4
  One-time cost: ~$0.001
  Cache for future
```

| Pros | Cons |
|------|------|
| Haiku downscale is always instant (Layer 1 ready) | Sonnet downscale has one-time delay |
| Very low ongoing cost ($0.0002 every 10 turns) | Slightly more complex than lazy |
| Best balance of speed and cost | |

**Cost per 100-turn session:** ~$0.002 (Layer 1 updates only)
**Downscale to Haiku:** 0ms (instant)
**Downscale to Sonnet:** 2-3 seconds (first time), 0ms (subsequent)

**Best for:** KairoClaw's use case — most downscales are to Haiku (simple follow-ups).

### Strategy Comparison Table

| Metric | Eager | Lazy | Hybrid |
|--------|-------|------|--------|
| **Ongoing cost/turn** | ~$0.0005 | $0.00 | ~$0.0002 |
| **Cost per 100-turn session** | $0.01 | $0.00-$0.002 | $0.002 |
| **Downscale latency (Haiku)** | 0ms | 2-5s first time | 0ms |
| **Downscale latency (Sonnet)** | 0ms | 2-5s first time | 2-3s first time |
| **Implementation complexity** | High | Low | Medium |
| **Wasted work** | Yes (layers built but unused) | None | Minimal |
| **Recommended for** | Frequent model switches | Rare switches | **KairoClaw** |

**Recommendation: Hybrid** — Layer 0+1 always fresh (covers 80% of downscales to Haiku), Layer 2+3 built on demand.

---

## 6. User Flow Visualization: Complete Task Session

### Scenario: UAE real estate agent using KairoClaw on WhatsApp

```
═══════════════════════════════════════════════════════════════
TURN 1: Greeting
═══════════════════════════════════════════════════════════════

User: "Good morning"
Router: simple greeting → HAIKU
Context: 500 tokens (Layer 4)
Layer 0: "New session, greeting"
Layer 1: not built yet (first turn)
Cost: $0.0004 (Haiku)

  ┌─────────────────────────────────────────────┐
  │ Model: Haiku    Context: 500 tokens          │
  │ Cost this turn: $0.0004                      │
  │ Cumulative: $0.0004                          │
  │ Layers: L4 ✅  L3 ❌  L2 ❌  L1 ❌  L0 ✅   │
  └─────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════
TURN 2: Simple question
═══════════════════════════════════════════════════════════════

User: "Do we have any 3BR villas available?"
Router: FAQ lookup → HAIKU (loads property-inquiry skill)
Context: 2K tokens
Layer 0: "Property inquiry session"
Cost: $0.0016 (Haiku)

  ┌─────────────────────────────────────────────┐
  │ Model: Haiku    Context: 2K tokens           │
  │ Cost this turn: $0.0016                      │
  │ Cumulative: $0.0020                          │
  │ Layers: L4 ✅  L3 ❌  L2 ❌  L1 ❌  L0 ✅   │
  └─────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════
TURN 3: Tool use (file read)
═══════════════════════════════════════════════════════════════

User: "Show me the details of Villa Marina 7"
Router: needs read_file tool → SONNET
Context: 5K tokens
Cost: $0.015 (Sonnet)

  ┌─────────────────────────────────────────────┐
  │ Model: Sonnet ⬆  Context: 5K tokens         │
  │ Cost this turn: $0.015                       │
  │ Cumulative: $0.017                           │
  │ Scale UP: Haiku → Sonnet (no issue)          │
  │ Layers: L4 ✅  L3 ❌  L2 ❌  L1 ❌  L0 ✅   │
  └─────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════
TURN 4: Follow-up (simple)
═══════════════════════════════════════════════════════════════

User: "What's the price?"
Router: simple follow-up → HAIKU
Context: 8K tokens < Haiku window (200K) → fits ✅
Cost: $0.006 (Haiku)

  ┌─────────────────────────────────────────────┐
  │ Model: Haiku ⬇  Context: 8K tokens          │
  │ Cost this turn: $0.006                       │
  │ Cumulative: $0.023                           │
  │ Scale DOWN: Sonnet → Haiku                   │
  │ Context fits in Haiku? YES (8K < 200K)       │
  │ Layer rebuild needed? NO                     │
  │ Layers: L4 ✅  L3 ❌  L2 ❌  L1 ❌  L0 ✅   │
  └─────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════
TURN 5-8: Research task (complex)
═══════════════════════════════════════════════════════════════

User: "Research all comparable villas in Dubai Marina, read every 
       listing file we have, and create a comparison report"
Router: complex multi-tool research → SONNET
Turns 5-8: multiple tool calls, reads 15 files
Context grows: 8K → 40K → 80K → 120K tokens
Cost: $0.36 (Sonnet, 4 turns)

  ┌─────────────────────────────────────────────┐
  │ Model: Sonnet ⬆  Context: 120K tokens       │
  │ Cost turns 5-8: $0.36                        │
  │ Cumulative: $0.383                           │
  │ Layers: L4 ✅  L3 ❌  L2 ❌  L1 ✅  L0 ✅   │
  │ (Layer 1 built at turn 8, every 10 turns)    │
  └─────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════
TURN 9: Quick acknowledgment
═══════════════════════════════════════════════════════════════

User: "Great, thanks"
Router: simple → HAIKU
Context: 125K tokens < Haiku window (200K) → fits ✅
Cost: $0.10 (Haiku — context is large but still fits)

  ┌─────────────────────────────────────────────┐
  │ Model: Haiku ⬇  Context: 125K tokens        │
  │ Cost this turn: $0.10                        │
  │ Cumulative: $0.483                           │
  │ Scale DOWN: Sonnet → Haiku                   │
  │ Context fits? YES (125K < 200K)              │
  │ No layer rebuild needed                      │
  └─────────────────────────────────────────────┘

  NOTE: Even though Haiku is "cheaper per token", the large context 
  (125K) means this turn still costs $0.10. The router could 
  optimize: if context > 50K and task is simple, consider whether 
  the Haiku savings outweigh the large context cost. In this case:
  
  Haiku:  125K × $0.80/1M = $0.10
  Sonnet: 125K × $3.00/1M = $0.375
  
  Haiku is still 3.75x cheaper even with large context. ✅

═══════════════════════════════════════════════════════════════
TURN 10-12: Deep analysis request
═══════════════════════════════════════════════════════════════

User: "Now analyze ALL listings, identify pricing patterns, predict 
       market trends, and write an investment recommendation report"
Router: complex reasoning + large context → OPUS
Context: 130K tokens → fits in Opus (1M)
Turns 10-12: deep analysis with tool calls
Context grows: 130K → 200K → 350K tokens
Cost: $5.25 (Opus, 3 turns — expensive but worth it for quality)

  ┌─────────────────────────────────────────────┐
  │ Model: Opus ⬆   Context: 350K tokens        │
  │ Cost turns 10-12: $5.25                      │
  │ Cumulative: $5.733                           │
  │ Layer 1 updated (turn 10)                    │
  │ Layers: L4 ✅  L3 ❌  L2 ❌  L1 ✅  L0 ✅   │
  └─────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════
TURN 13: Follow-up question
═══════════════════════════════════════════════════════════════

User: "Which villa has the best ROI?"
Router: medium complexity → SONNET
Context: 355K tokens > Sonnet window (200K) ❌

  ┌─────────────────────────────────────────────┐
  │ Router wants: Sonnet                         │
  │ Context: 355K > Sonnet window (200K) ❌      │
  │                                              │
  │ WITHOUT LAYERS (today's design):             │
  │   → Force compaction (LLM call, ~$0.01)      │
  │   → Destroy 200K tokens of history           │
  │   → Summary loses detail                     │
  │   → THEN send to Sonnet                      │
  │                                              │
  │ WITH LAYERS (new design):                    │
  │   → Build Layer 3 from Layer 4 (one-time)    │
  │   → Layer 3: 140K tokens (fits in Sonnet!)   │
  │   → No data destroyed, just a different view │
  │   → Send Layer 3 to Sonnet                   │
  │   → Cost: $0.001 (Haiku builds Layer 3)      │
  └─────────────────────────────────────────────┘

WITH LAYERS:
  Layer 3 built: truncate old tool results → 140K tokens
  Send to Sonnet: $0.42 (Sonnet on 140K)
  Total this turn: $0.421

  ┌─────────────────────────────────────────────┐
  │ Model: Sonnet ⬇  Context: 140K (Layer 3)    │
  │ Cost this turn: $0.421                       │
  │ Cumulative: $6.154                           │
  │ Layers: L4 ✅  L3 ✅  L2 ❌  L1 ✅  L0 ✅   │
  │ Layer 3 built for first time (cached)        │
  └─────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════
TURN 14: Simple wrap-up
═══════════════════════════════════════════════════════════════

User: "Send this report to Ahmed on WhatsApp"
Router: simple tool call → HAIKU
Context: 360K tokens > Haiku window (200K) ❌

  Layer 1 exists: 8K tokens → fits in Haiku ✅
  Use Layer 1 + the current user message
  Haiku sees: key facts + active task + "send to Ahmed"
  
  Cost: $0.007 (Haiku on 8K)

  ┌─────────────────────────────────────────────┐
  │ Model: Haiku ⬇  Context: 8K (Layer 1)       │
  │ Cost this turn: $0.007                       │
  │ Cumulative: $6.161                           │
  │ No rebuild needed — Layer 1 was ready        │
  │ Layers: L4 ✅  L3 ✅  L2 ❌  L1 ✅  L0 ✅   │
  └─────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════
SESSION COMPLETE — COST SUMMARY
═══════════════════════════════════════════════════════════════
```

### Cost Comparison for This Session

| Turn | Task | All-Sonnet | All-Opus | With Router |
|------|------|----------:|--------:|-----------:|
| 1 | Greeting | $0.002 | $0.008 | $0.0004 (Haiku) |
| 2 | FAQ | $0.006 | $0.030 | $0.002 (Haiku) |
| 3 | File read | $0.015 | $0.075 | $0.015 (Sonnet) |
| 4 | Follow-up | $0.024 | $0.120 | $0.006 (Haiku) |
| 5-8 | Research | $0.360 | $1.800 | $0.360 (Sonnet) |
| 9 | Thanks | $0.375 | $1.875 | $0.100 (Haiku) |
| 10-12 | Deep analysis | $1.050 | $5.250 | $5.250 (Opus) |
| 13 | ROI question | $0.420 | $2.100 | $0.421 (Sonnet+L3) |
| 14 | Send report | $0.380 | $1.900 | $0.007 (Haiku+L1) |
| **Total** | | **$2.632** | **$13.158** | **$6.161** |
| **Layer overhead** | | $0 | $0 | $0.003 |

Wait — the routed version is MORE expensive than all-Sonnet because of the Opus calls. Let me recalculate **without Opus** (using Sonnet for turns 10-12):

| Scenario | Total Cost | Quality on complex tasks |
|----------|----------:|------------------------|
| **All-Haiku** | $0.89 | Poor (misses nuance on complex tasks) |
| **All-Sonnet** | $2.63 | Good (but overpays for simple tasks) |
| **All-Opus** | $13.16 | Excellent (but 5x overpay) |
| **Routed (Haiku+Sonnet)** | $1.78 | Good (same as Sonnet where it matters) |
| **Routed (Haiku+Sonnet+Opus)** | $6.16 | **Excellent** (Opus only where needed) |

**The sweet spot for UAE SMEs: Haiku+Sonnet routing (no Opus) saves 32% vs all-Sonnet with same quality.**

Opus should be **opt-in** — businesses choose whether they want premium quality on complex tasks.

---

## 7. Cost Impact by Strategy (for the session above)

### Eager Strategy Costs
```
Layer maintenance: 14 turns × $0.0005 avg = $0.007
Model routing: saves $0.85 (Sonnet → Haiku on simple turns)
Net savings: $0.843
```

### Lazy Strategy Costs
```
Layer maintenance: $0 (no layers built proactively)
First downscale (turn 13): build Layer 3 = $0.001
Second downscale (turn 14): Layer 1 not ready = $0.001 to build
Net savings: $0.848 (slightly more than eager)
BUT: 2-3 second delay on turn 13 and 14 (building layers)
```

### Hybrid Strategy Costs
```
Layer maintenance: Layer 0+1 updates = $0.001 (over 14 turns)
First downscale to Haiku (turn 4): Layer 1 ready → instant
First downscale to Sonnet (turn 13): build Layer 3 = $0.001
Net savings: $0.847
Downscale to Haiku: instant (L1 ready)
Downscale to Sonnet: 2s delay (one time)
```

### Strategy Comparison for This Session

| Strategy | Layer overhead | Savings from routing | Net savings | UX (latency) |
|----------|-------------:|---------------------:|-----------:|---------------|
| **No routing (today)** | $0 | $0 | $0 | No delay |
| **Eager** | $0.007 | $0.850 | **$0.843** | No delay |
| **Lazy** | $0.002 | $0.850 | **$0.848** | 2-3s on first switch |
| **Hybrid** | $0.002 | $0.850 | **$0.848** | 0s to Haiku, 2s to Sonnet (once) |

**All strategies save ~$0.85 per session. The difference is in UX, not cost.**

---

## 8. Monthly Projections for a KairoClaw Business

### 50 SME customers, average 30 messages/day each

| Scenario | Monthly cost | Monthly savings |
|----------|------------:|----------------:|
| All-Sonnet (today) | **$135** | — |
| Routed Haiku+Sonnet | **$92** | $43 (32%) |
| Routed + Opus opt-in (10 customers) | **$120** | $15 (11%) but better quality |

### 200 SME customers (scale target)

| Scenario | Monthly cost | Monthly savings |
|----------|------------:|----------------:|
| All-Sonnet | **$540** | — |
| Routed Haiku+Sonnet | **$367** | **$173/month** (32%) |

**$173/month savings at 200 customers = $2,076/year. That's pure margin.**

---

## 9. Current Compaction Design vs Context Layers

### Today: Destructive Compaction

```
Context at 150K (75% of 200K Sonnet window)
    │
    ▼
Hard compaction fires:
    1. LLM summarizes old messages ($0.01 Haiku call)
    2. DELETE old messages from DB
    3. INSERT summary as system message
    4. Context drops to ~20K
    
    ❌ Old messages GONE forever
    ❌ If user asks "what did we discuss earlier?" → vague summary only
    ❌ Cannot switch to Opus and recover full context
    ❌ File restoration partially helps but limited to 5 files
```

### With Context Layers: Non-Destructive

```
Context at 350K (Opus session)
Router wants to switch to Sonnet (200K window)
    │
    ▼
Select Layer 3 (140K — fits in Sonnet):
    1. Layer 3 = messages + truncated tool results
    2. NO deletion. Layer 4 (full) still in DB.
    3. Send Layer 3 to Sonnet
    
    ✅ Full history preserved (Layer 4)
    ✅ User asks "what did we discuss?" → switch to Opus, use Layer 4
    ✅ Downscale is instant if layer already built
    ✅ No LLM call needed for "compaction" (just view selection)
```

### Side-by-Side: Same Session, Both Approaches

```
Turn 12: Context at 350K (on Opus)
Turn 13: User asks "which villa has best ROI?" (medium complexity)

─── TODAY (destructive compaction) ───────────────────────
  1. Router: "use Sonnet" but 350K > 200K
  2. Force compaction: Haiku summarizes → $0.01
  3. Old messages deleted. Context: 20K
  4. Send to Sonnet: 20K context
  5. Sonnet answers based on SUMMARY (lost detail)
  
  Cost: $0.01 (compact) + $0.06 (Sonnet 20K) = $0.07
  Quality: DEGRADED (working from summary)
  Data: LOST (old messages deleted)

─── WITH LAYERS (non-destructive) ───────────────────────
  1. Router: "use Sonnet" but 350K > 200K  
  2. Build Layer 3: truncate tool results → 140K (free string op)
  3. Send Layer 3 to Sonnet: 140K context
  4. Full Layer 4 still in DB (350K preserved)
  
  Cost: $0.42 (Sonnet 140K) = $0.42
  Quality: FULL (all messages available, just tool results truncated)
  Data: PRESERVED (Layer 4 untouched)

─── COMPARISON ──────────────────────────────────────────
  Compaction: cheaper ($0.07) but LOSES data
  Layers: more expensive ($0.42) but PRESERVES everything
  
  Trade-off: pay $0.35 more to keep full history available
```

### When Each Approach Wins

| Situation | Better approach | Why |
|-----------|----------------|-----|
| Long session, won't need old context again | Compaction | Cheaper, old context not needed |
| Research session, user may refer back | Layers | History preserved for follow-ups |
| Simple FAQ session (Haiku only) | Neither needed | Context never grows large |
| Mixed session (research → simple → research) | Layers | Can switch between detail levels |
| Budget-constrained (casual user) | Compaction | Minimizes per-turn cost |
| Quality-focused (business analysis) | Layers | No information loss |

### Hybrid: Layers + Compaction Together

Best of both worlds:

```
Session starts:
    Layer 0-1: maintained (cheap)
    Layer 2-3: lazy (built on demand)
    Layer 4: DB messages (always)

Context grows past 75% of current model:
    → Use layers for model switching (non-destructive)
    
Context grows past Layer 4 capacity (extremely long session):
    → THEN fall back to traditional compaction on Layer 4
    → But Layer 1-3 still available as cached views
    → Much rarer event (only for very long sessions)
```

---

## 10. Decision Matrix

| Factor | Weight | Compaction only | Layers only | Hybrid (layers + compaction) |
|--------|--------|:-:|:-:|:-:|
| Cost (simple users) | High | ★★★ | ★★ | ★★★ |
| Cost (power users) | High | ★★ | ★★ | ★★★ |
| Quality preservation | High | ★ | ★★★ | ★★★ |
| Implementation complexity | Medium | ★★★ | ★ | ★★ |
| Model switching speed | High | ★ | ★★★ | ★★★ |
| Memory efficiency | Medium | ★★★ | ★★ | ★★ |
| Data recovery | Low | ★ | ★★★ | ★★★ |
| **Total** | | **14** | **16** | **19** |

**Recommendation: Hybrid (layers + compaction as fallback) is the best approach for KairoClaw.**

---

## 11. Implementation Phases

### Phase 1: Model Router (Medium effort)
- Rule-based routing (message length, keywords, tool count)
- Simple: if context fits smaller model, use it
- No layers needed yet — just "don't downscale if context too big"

### Phase 2: Layer 0 + 1 (Low effort)
- Layer 0: one-line topic (rule-based, free)
- Layer 1: key facts + active task (Haiku call every 10 turns)
- Enables instant downscale to Haiku

### Phase 3: Layer 2 + 3 (Medium effort)
- Layer 2: structured summary + recent messages (Haiku, lazy)
- Layer 3: messages + truncated tool results (string op, lazy)
- Enables downscale to Sonnet without data loss

### Phase 4: Full Integration (High effort)
- Layers replace compaction for model switching
- Compaction only fires for extremely long sessions (Layer 4 > 1M)
- Admin dashboard shows layer status per session
