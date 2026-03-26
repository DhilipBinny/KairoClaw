# Channels — Features & Constraints

KairoClaw supports three messaging channels: **Web Chat**, **Telegram**, and **WhatsApp**. Each channel connects to the same AI agent — same tools, same memory, same persona.

---

## Web Chat

**Type:** Built-in, always available
**Protocol:** WebSocket (`/ws`)

### Features
- Real-time streaming responses
- Session management (create, switch, delete)
- Tool call visualization with collapsible details
- Markdown rendering with syntax highlighting
- Image support (paste/upload)
- File upload (PDF, documents, audio, video — via attach button)
- Multi-session support

### Constraints
- Authenticated via API key (each user has their own key)
- No mobile app — browser only
- Sessions are per-browser (localStorage)

### Setup
No setup needed. Available at `http://localhost:18181` after starting the server.

---

## Telegram

**Type:** Bot account (separate from personal Telegram)
**Protocol:** Grammy library, long-polling
**Account:** Dedicated bot via [@BotFather](https://t.me/BotFather)

### Features
- Direct messages (1:1 with the bot)
- Group chat support (configurable)
- Mention detection (`@botname` or reply-to-bot)
- Text, photo, and document messages
- AI-generated image sending (inline from agent responses)
- Allow-list filtering by user/group ID
- Hot-reload — enable/disable from admin UI without restart

### Configuration (Admin UI → Channels)

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | Off | Start/stop the bot |
| Bot Token | — | From [@BotFather](https://t.me/BotFather). Saved to secrets store. |
| Groups Enabled | On | Whether the bot responds in group chats |
| Require Mention | On | In groups, only respond when @mentioned or replied to |
| Allowed Groups | [] (all) | Group chat IDs. Empty = all groups allowed. |
| Allow From | [] (all) | User IDs that can interact. Empty = no restriction. |

### Scenarios

| Scenario | Works? | Notes |
|----------|--------|-------|
| DM the bot | Yes | Send any message, bot responds |
| Add bot to group as admin | Yes | Bot joins, listens for mentions |
| Group: @mention the bot | Yes | Bot responds to the message |
| Group: reply to bot's message | Yes | Bot responds to the reply |
| Group: regular message (no mention) | No (default) | Ignored when Require Mention = On |
| Multiple groups | Yes | Each group is an independent session |
| Send images to bot | Yes | Converted to base64, sent to vision-capable models |

### Constraints
- Bot cannot initiate conversations (Telegram restriction)
- Bot token is permanent — regenerating via BotFather disconnects KairoClaw
- Rate limits apply (Telegram's global limits, not KairoClaw's)
- Bot sees all group messages but only processes mentions (when Require Mention = On)

### Setup
1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → get token
2. Admin UI → Channels → Telegram → Set Token → paste token → Save
3. Toggle Enabled → On
4. Message your bot on Telegram

---

## WhatsApp

**Type:** Linked device (piggybacks on a personal WhatsApp account)
**Protocol:** Baileys library (unofficial WhatsApp Web protocol)
**Account:** Your existing phone number — NOT a separate bot account

### Features
- Direct messages (1:1)
- Group chat support (configurable)
- Mention detection (`@phone` or quote-reply)
- Text, image, document, voice, and video messages
- Read receipts (configurable)
- QR code pairing from admin UI
- Auto-reconnect with exponential backoff
- LID-to-phone resolution (WhatsApp's linked identity system)
- Allow-list filtering by phone number
- Hot-reload — enable/disable from admin UI without restart

### Configuration (Admin UI → Channels)

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | Off | Start/stop the WhatsApp connection |
| Groups Enabled | On | Whether the bot responds in group chats |
| Require Mention | On | In groups, only respond when @mentioned or replied to |
| Allowed Groups | [] (all) | Group JIDs. Empty = all groups allowed. |
| Read Receipts | On | Send blue ticks when bot reads a message |
| Allow From | [] (all) | Phone numbers (e.g., `1234567890`). Empty = no restriction. |

### Scenarios

| Scenario | Works? | Notes |
|----------|--------|-------|
| Someone DMs your number | Yes | Bot auto-responds if sender is in Allow From |
| You DM yourself | No | Messages from self (`fromMe`) are ignored |
| Group: someone @mentions you | Yes | Bot responds to the message |
| Group: someone quote-replies to you | Yes | Bot responds |
| Group: regular message (no mention) | No (default) | Ignored when Require Mention = On |
| Send images to bot | Yes | Converted to base64 for vision models |
| Send documents | Yes | Downloaded to workspace, path shared with agent |
| Send voice messages | Yes | Downloaded to workspace as .ogg file |

### Critical Constraints

| Constraint | Impact |
|------------|--------|
| **Bot IS your phone number** | People messaging you don't know they're talking to AI. The bot responds AS you. |
| **No separate bot account** | Unlike Telegram, there's no isolated bot identity. All messages to your number are intercepted. |
| **Concurrent usage** | Your phone app still works, but bot may respond before you do. Causes confusion with double replies. |
| **Unofficial protocol** | Baileys is reverse-engineered WhatsApp Web. Can break when WhatsApp updates their protocol. |
| **Rate limits** | WhatsApp aggressively rate-limits automated messaging. High volume will get your number temporarily banned. |
| **Session persistence** | Credentials saved in `~/.agw/whatsapp/`. Survives restarts. Must unpair + re-scan QR to reset. |
| **Linked device expiry** | WhatsApp linked devices expire if the phone is offline for ~14 days. Must re-scan QR. |

### Recommended Setup

**Option A: Dedicated SIM (Recommended)**
- Use a separate phone number with a cheap SIM/eSIM
- Install WhatsApp on a secondary device or tablet
- Scan QR from admin UI
- Your personal WhatsApp is completely unaffected

**Option B: Personal number with strict Allow From**
- Set `allowFrom` to only specific numbers you trust
- Everyone else is silently ignored
- But allowed numbers will see bot responses as coming from "you"

**Option C: Group-only mode**
- Set `allowFrom: []` (empty — blocks all DMs since nobody matches)
- Set `Groups Enabled: On`
- Bot only responds in groups when @mentioned
- Your DMs remain untouched

### Setup
1. Admin UI → Channels → WhatsApp → Toggle Enabled → On
2. QR code appears on the Channels page
3. On your phone: WhatsApp → Settings → Linked Devices → Link a Device → Scan QR
4. Status changes to "Connected" with phone number displayed
5. Configure Allow From with trusted phone numbers

---

## Channel Comparison

| Feature | Web Chat | Telegram | WhatsApp |
|---------|----------|----------|----------|
| Setup complexity | None | Easy (BotFather) | Medium (QR pairing) |
| Separate bot account | N/A | Yes | No (uses your number) |
| Group support | No | Yes | Yes |
| Image input | Yes | Yes | Yes |
| Image output | Markdown | Yes (native photo) | Yes (native photo) |
| Voice messages | No | No | Yes (saved to disk) |
| Documents | Yes (file upload) | Yes | Yes (saved to disk) |
| PDF analysis | Yes (via read_pdf) | Yes (via read_pdf) | Yes (via read_pdf) |
| Allow-list (users) | No (API key auth) | By user ID | By phone number |
| Allow-list (groups) | N/A | By group chat ID | By group JID |
| Per-user memory | Yes (scoped by user account) | Yes (scoped) | Yes (scoped) |
| Hot-reload | N/A | Yes | Yes |
| Read receipts | N/A | N/A | Configurable |
| Mention in groups | N/A | @botname or reply | @phone or reply |
| Protocol | WebSocket | Official Bot API | Unofficial (Baileys) |
| Reliability | High | High | Medium (protocol changes) |
| Rate limits | None (self-hosted) | Telegram limits | Aggressive WhatsApp limits |

---

## Sender & Group Discovery

Users AND groups are tracked in a bounded `pending_senders` table for admin approval. This enables zero-friction onboarding for both individual users and group chats.

### Design Constraints

| Constraint | Value | Rationale |
|------------|-------|-----------|
| `seen` rows (discovery) | **5 per channel** | For initial onboarding. Oldest evicted when full. |
| `pending` rows (rejected) | **20 per channel** | Ongoing approval queue. Oldest evicted when full. Prevents unbounded growth. |
| Data stored | **Metadata only** | sender ID, name, channel, timestamps, message count. No message content stored. |
| Total max rows | **50** | 5 seen + 20 pending per channel, 2 channels. Fixed ceiling regardless of traffic. |
| Already approved/rejected | **Skipped** | Once approved or rejected, senders are not re-recorded. |

### How It Works

| Allowlist state | Sender/Group outcome | Recorded as | UI section |
|-----------------|---------------------|-------------|------------|
| Empty (allow all) | Bot responds | `seen` | Discovered |
| Has entries, sender matches | Bot responds | Not recorded | — |
| Has entries, sender doesn't match | Bot ignores | `pending` | Pending Approvals |

Groups and individuals share the same `pending_senders` table. The admin UI shows a **"Group"** badge next to group entries.

### Individual Onboarding

1. Deploy with empty allowlist → bot allows everyone
2. Message your bot → you appear in "Discovered" on Channels page
3. Click "Approve" → your ID added to `allowFrom`, bot now restricted
4. Anyone else who messages → silently rejected, appears in "Pending"
5. Approve or reject from the admin UI
6. **Telegram**: Use `/myid` to discover your user ID

### Group Onboarding

1. Add bot to a group → group appears in "Discovered" or "Pending" on Channels page
2. Admin clicks "Approve" → group ID added to `groupAllowFrom` (not `allowFrom`)
3. Bot starts responding in that group
4. **Telegram**: Use `/groupid` in a group to discover the group's chat ID

### Approval Routing

The approve endpoint automatically detects groups vs individuals:
- **Telegram groups**: sender_id starts with `-` (negative number) → routes to `groupAllowFrom`
- **WhatsApp groups**: sender_id ends with `@g.us` → routes to `groupAllowFrom`
- **Individuals**: routes to `allowFrom`

### Bot Commands (Telegram)

| Command | Where | Description |
|---------|-------|-------------|
| `/start` | DM | Welcome message |
| `/help` | DM | List commands |
| `/myid` | DM | Show your user ID + allowlist instructions |
| `/groupid` | Group | Show group chat ID + allowlist instructions |

### Abuse Scenario (1M bots hitting your endpoint)

- Each unique rejected sender = 1 row, but table capped at 20 pending per channel
- 21st sender evicts the oldest row → table never grows past 20
- Bot silently ignores all rejected senders — no response, no resource consumption beyond the allowlist check
- Messages are NOT stored or processed

---

## Cron Job Delivery

Cron jobs can deliver results to any channel. Configure delivery targets per job:

```json
{
  "delivery": {
    "mode": "announce",
    "targets": [
      { "channel": "telegram", "to": "-1001234567890" },
      { "channel": "whatsapp", "to": "1234567890@s.whatsapp.net" },
      { "channel": "web" }
    ]
  }
}
```

- **Telegram `to`**: Chat ID (negative for groups, positive for DMs)
- **WhatsApp `to`**: Phone number in JID format (`phone@s.whatsapp.net`)
- **Web**: No `to` needed — broadcasts to all connected web clients
- Multiple targets per channel supported (e.g., two Telegram groups)
