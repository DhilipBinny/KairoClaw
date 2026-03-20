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

- `packages/core/src/security/outbound.ts` — validation logic
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
