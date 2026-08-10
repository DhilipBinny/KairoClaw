# Design Constraints & Considerations

Living document of architectural constraints, design decisions, and considerations across all modules. Reference this when making changes that touch these areas.

---

## Outbound Messaging Security

**Implemented**: 2026-03-20 | **Research**: [OUTBOUND_SECURITY.md](./_local_reference/research/OUTBOUND_SECURITY.md)

### Constraint: Default-Deny Outbound

The bot MUST NOT send messages to any recipient that hasn't been explicitly authorized. This prevents the LLM from messaging arbitrary phone numbers, leaking data to unknown contacts, or spamming.

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Default policy | `session-only` | Bot can only message contacts that messaged it first. Safest default. |
| User-specified allowlist | `outboundAllowlist[]` per channel | Users can explicitly authorize numbers (e.g., "send reminders to +6512345678") |
| Admin bypass | Admin/web UI crons are unrestricted | Admin created crons from web UI can target any channel freely |
| Enforcement point | `sharedServices.*Send()` + cron `deliverer` in `index.ts` | Single chokepoint — all outbound flows through here |
| Cron validation | At creation AND delivery time | Belt and suspenders — reject bad targets early, but also check at delivery |
| No audit table | Pino structured logs only | Sufficient for now. Dedicated outbound_log table is P3. |

### Outbound Flow

```
send_message tool  -->  sharedServices.whatsappSend()  -->  channel.sendToChat()
                        sharedServices.telegramSend()       channel.sendToChat()

cron deliverer     -->  checkOutboundAllowed()  -->  channel.sendToChat()

broadcastToWeb     -->  WebSocket push (no restriction — internal only)
```

### Config

```json
{
  "channels": {
    "whatsapp": {
      "outboundPolicy": "session-only",
      "outboundAllowlist": ["6591234567@s.whatsapp.net"]
    },
    "telegram": {
      "outboundPolicy": "session-only",
      "outboundAllowlist": ["-1001234567890"]
    }
  }
}
```

### Key Files

- `packages/core/src/security/outbound.ts` — re-export shim. Main implementation: `packages/security/src/outbound.ts`
- `packages/core/src/index.ts` (sharedServices + deliverer) — enforcement
- `packages/core/src/tools/builtin/messaging.ts` — cron creation validation
- `packages/types/src/config.ts` — `outboundPolicy` + `outboundAllowlist` types

### Constraints

- **Session lookup uses `chat_id` column** — sessions are stored as `whatsapp:<JID>` or `telegram:<chatId>`. The validator matches this pattern.
- **Allowlist matches phone part** — `6591234567` matches `6591234567@s.whatsapp.net`. Stripping `@domain` allows flexible input.
- **LIKE fallback query** — if exact `channel:recipient` doesn't match, a `LIKE %recipient%` fallback catches format mismatches. This is slightly loose but only makes the policy more permissive (never more restrictive).
- **Web channel has no outbound restriction** — `broadcastToWeb` is internal WebSocket push, not an external message.
- **Existing crons with invalid targets** — won't crash. Delivery is silently skipped with a warning log.

### Future Work (Not Yet Implemented)

- **P1: Human-in-the-loop approval** — agent pauses before risky tool calls and asks user to confirm
- **P1: Delivery scope locking** — crons from WhatsApp can only deliver to same chat + web
- **P2: Per-channel tool permissions** — restrict which tools each channel can use
- **P2: Outbound rate limiting** — per-channel rate limits on outbound messages
- **P3: Outbound audit trail** — dedicated DB table + admin UI for outbound message history

---

## WhatsApp LID Resolution

**Implemented**: 2026-03-20

### Constraint: Sessions Must Use Deliverable Addresses

WhatsApp internally uses LIDs (Linked Identities, e.g., `145256465039448@lid`) for some contacts instead of phone-based JIDs (`6590890177@s.whatsapp.net`). LIDs are NOT deliverable — `sendMessage()` to a LID fails.

### Design Decision

For private chats where the JID is a LID, resolve to `<phone>@s.whatsapp.net` before creating the session. This ensures `chat_id` in the sessions table is always a deliverable address.

### Key Files

- `packages/core/src/channels/whatsapp.ts` — LID resolution in `handleMessage()`

### Constraint

- Resolution depends on Baileys' auth state files or the in-memory `lidToPhone` cache
- If the LID cannot be resolved (no cache entry, no auth state file), the raw LID is used as fallback — this is unavoidable but rare

---

## Cron Delivery Target Auto-Fill

**Implemented**: 2026-03-20

### Constraint: LLM Must Not Fabricate Delivery Addresses

The LLM was hallucinating phone numbers when creating cron jobs. Users should never need to provide their own address — the system knows it from the session.

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Auto-fill from session | `to` left empty = auto-fill from `session.chat_id` | Prevents hallucination. LLM just says "this chat". |
| Override hallucinated values | Bare numbers without `@s.whatsapp.net` get overridden | Catches LLM fabrication |
| Sentinel values | `_current`, `current`, `same` all trigger auto-fill | Multiple ways for LLM to express "same chat" |
| JID format validation | WhatsApp `to` must contain `@` | Rejects bare phone numbers |
| `manage_cron run` description | Explicitly says "run executes AND delivers" | Prevents LLM from using `send_message` separately |

### Key Files

- `packages/core/src/tools/builtin/messaging.ts` — auto-fill logic + `send_message` auto-fill
- `packages/core/src/channels/whatsapp.ts` — LID → phone resolution

---

## Tool Description as LLM Guardrail

**Pattern used across**: messaging tools, cron tools

### Constraint: Tool Descriptions Are Security Boundaries

The LLM decides which tool to use and what arguments to pass based entirely on the tool description. Ambiguous or incomplete descriptions lead to wrong tool choices and hallucinated arguments.

### Guidelines

- **Be explicit about what NOT to do**: "Do NOT guess phone numbers" is more effective than "auto-fill is available"
- **State side effects clearly**: "run executes AND delivers to saved targets" prevents the LLM from double-sending
- **Provide format examples**: `"<phone>@s.whatsapp.net"` prevents bare number hallucination
- **Leave defaults implicit**: "Leave to empty for current chat" is better than requiring the LLM to know the JID

---

## Code Execution Safety

**Implemented**: 2026-06-12 (PR #177) | **Status**: Resolved

### Original Constraint: Exec Tool Is Dangerous

The `exec` tool ran commands directly on the host OS. Any user could potentially execute destructive commands (`rm -rf`, network scans, file exfiltration). This was a critical security risk for a multi-user platform.

### Resolution: Docker-Based Sandbox Execution

A dedicated `@agw/sandbox` package provides isolated Docker containers for code execution. The sandbox enforces:

- **Container isolation** — each execution runs in a disposable container with no host access
- **Network policy** — configurable network restrictions per sandbox session
- **Mount resolver** — controlled filesystem mounts, no arbitrary host path access
- **Resource limits** — CPU, memory, and timeout constraints on containers
- **Command filtering** — blocked command patterns prevent dangerous operations even inside containers

### Key Files

- `packages/sandbox/` — Docker client, container manager, network policy, config
- `packages/tools-common/src/sandbox-exec.ts` — sandboxed exec tool implementation
- `packages/tools-common/src/exec.ts` — host exec with policy-based command filtering
- `packages/core/src/routes/sandbox.ts` — admin API for sandbox management
- `packages/types/src/sandbox.ts` — shared sandbox types

### Remaining Constraints

- Sandbox requires Docker on the host — falls back to policy-filtered host exec if Docker is unavailable
- Container startup adds latency (~200-500ms) compared to direct exec

---

## System Alerting

**Implemented**: 2026-06-15 | **Status**: Partially Resolved (addresses #133)

### Original Constraint: Silent Failures

Channel disconnections, provider errors, cron failures, and health issues went unnoticed. Operators had to manually check logs to discover problems. There was no proactive notification system.

### Resolution: Alert Manager with Multi-Channel Delivery

A full alerting subsystem with state machine (inactive -> pending -> firing -> resolved), configurable thresholds, cooldown periods, and multiple delivery channels.

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Alert states | `inactive` -> `pending` -> `firing` -> `resolved` | Prevents alert storms; groups rapid failures before notifying |
| Fingerprinting | SHA-256 of `type:sorted-labels` | Deduplicates identical alerts across events |
| Delivery channels | Telegram, WhatsApp (future), WebSocket, Webhook | Operators get alerts where they already are |
| Circular delivery prevention | Skip channel X when alerting about channel X disconnect | Avoids trying to send "Telegram is down" via Telegram |
| Cooldown periods | Separate for critical vs warning severity | Critical alerts repeat more aggressively |
| Persistence | `alert_history` table with retention cleanup | Audit trail with automatic old record pruning |
| Per-event config | `config.alerts.events[type]` overrides global thresholds | Fine-grained control per alert type |

### Alert Types

- `channel.disconnected` — messaging channel lost connection
- `channel.auth_lost` — channel authentication expired
- `provider.error` — LLM provider returning errors
- `cron.failure` — scheduled job execution failed

### Key Files

- `packages/core/src/alerts/index.ts` — AlertManager (state machine, delivery, persistence)
- `packages/core/src/alerts/state.ts` — AlertStateStore (in-memory alert instances)
- `packages/core/src/alerts/health/channel-probe.ts` — channel health probing
- `packages/core/src/alerts/channels/` — delivery: telegram, websocket, webhook
- `packages/types/src/alert.ts` — alert types, interfaces, config shapes
- `packages/core/src/db/migrations/*/016_alert_history.sql` — persistence schema

### Remaining Constraints

- WhatsApp alert delivery channel not yet implemented (Telegram, WebSocket, Webhook are live)
- No admin UI panel for alert history browsing yet
- Per-user alert routing not yet supported — alerts go to all configured channels

---

## Database Backups

**Implemented**: 2026-06-12 | **Status**: Resolved

### Original Constraint: No Automated Backups

There was no backup mechanism. A corrupted database or accidental deletion meant total data loss. This was unacceptable for a production system.

### Resolution: Daily Automated Backups (SQLite + PostgreSQL)

The cron scheduler runs a daily backup job supporting both database engines:

- **SQLite** — uses the native backup API (`database.backup()`) for consistent, non-blocking backups
- **PostgreSQL** — uses `pg_dump` with the password passed via `PGPASSWORD` environment variable (not argv, for security)

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Schedule | Daily (cron-based) | Balances data protection with storage usage |
| SQLite method | Native backup API | Atomic, consistent snapshot without locking the DB |
| PostgreSQL method | `pg_dump` via `PGPASSWORD` env | Standard tool; env var avoids password in process list |
| Storage | Local filesystem | Simple; operators can layer cloud sync externally |

### Key Files

- `packages/cron/src/scheduler.ts` — backup job scheduling and execution
- `packages/core/src/constants.ts` — backup-related constants

### Remaining Constraints

- Backups are local only — no built-in cloud storage upload (S3, GCS)
- No backup rotation/retention policy yet — old backups accumulate
- No backup verification (restore test) automation

---

## Sub-Agent Resource Limits

**Implemented**: 2026-06-12 | **Status**: Resolved

### Original Constraint: Unbounded Sub-Agent Execution

Sub-agents (spawned by the main agent for parallel tasks) had no concurrency limit or timeout. A runaway prompt could spawn unlimited sub-agents, exhausting memory and API credits. A stuck sub-agent would hang indefinitely.

### Resolution: Concurrency Cap + Timeout

Two constants in `packages/core/src/constants.ts` enforce hard limits:

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_IN_TURN_SUBAGENTS` | 10 | Maximum concurrent sub-agents per agent turn |
| `SUBAGENT_TIMEOUT_MS` | 300,000 (5 min) | Hard timeout per sub-agent execution |

### Behavior

- If a turn attempts to spawn more than 10 sub-agents, additional requests are rejected
- Any sub-agent running longer than 5 minutes is forcibly terminated
- Both limits apply per-turn, resetting for each new agent invocation

### Key Files

- `packages/core/src/constants.ts` — `MAX_IN_TURN_SUBAGENTS`, `SUBAGENT_TIMEOUT_MS`

### Remaining Constraints

- Limits are global constants, not per-user configurable
- No admin UI to adjust limits at runtime
- No per-user sub-agent budget tracking
