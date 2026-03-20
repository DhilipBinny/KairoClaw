# AGW — Product Features

> **Agentic Gateway** — A self-hosted personal AI gateway that connects LLMs to messaging channels, tools, and scheduled tasks.
>
> Version: 2.0 | Updated: 2026-03-19 | Audited from source code

---

## At a Glance

| Metric | Value |
|--------|-------|
| API endpoints | 40+ REST + 1 WebSocket |
| Built-in tools | 10 (files, exec, web, messaging, memory) |
| Channels | 3 (Telegram, WhatsApp, Web Chat) |
| LLM providers | 3 (Anthropic, OpenAI, Ollama) |
| Known models | 9 built-in + unlimited custom |
| Database tables | 10 |
| Config options | 20+ across 8 sections |
| Slash commands | 7 |
| Log categories | 12 structured categories |

---

## 1. Agent System (ReAct Loop)

The core of AGW — a multi-round agent that calls LLMs, executes tools, and manages context.

### How It Works
1. User sends a message via any channel
2. Agent builds system prompt (persona files + memory + tool definitions)
3. LLM call → if tool calls in response → execute tools → feed results back → repeat
4. Maximum 25 rounds per turn (configurable)
5. Final text response delivered to the user's channel

### Features
- **Streaming**: Token-by-token streaming via WebSocket (text only, not tool calls)
- **Vision**: Detects model capabilities, builds multimodal content with base64 images
- **Context compaction**: When conversation exceeds 75% of context window, auto-summarizes older messages via LLM
- **Content-aware token estimation**: Code = 3.2 chars/token, text = 3.8 (not fixed 4)
- **Tool output budget**: 10KB per tool, 30KB per round — prevents context overflow
- **LLM metrics**: Every call logged with inputTokens, outputTokens, latencyMs, costUsd, stopReason
- **Auto-memory**: After each real conversation, extracts new facts to layered memory (fire-and-forget, doesn't block response)
- **Output safety**: Redacts 10+ secret patterns (API keys, JWTs, DB URLs, OAuth tokens)
- **Prompt injection detection**: Flags 7 known patterns (not blocking — logs only)

### Slash Commands
| Command | Action |
|---------|--------|
| `/new` / `/reset` | Clear session messages |
| `/status` | Show session stats (turns, tokens, model, compaction) |
| `/compact` | Force context compaction |
| `/model provider/model` | Switch active model |
| `/sessions` | List all sessions with usage |
| `/help` | List commands |
| `/stop` | Acknowledge stop (generation continues server-side) |

### System Prompt
Built from workspace persona files, automatically loaded:
- `IDENTITY.md` — agent name, role
- `SOUL.md` — personality, tone
- `USER.md` — user info, preferences
- `AGENTS.md` — operating rules
- `MEMORY.md` — curated notes
- `memory/PROFILE.md` — long-term memory (auto-generated)
- `memory/sessions/*.md` — recent session notes (last 3 days)

### Limitations
- Token estimation is heuristic (not an actual tokenizer)
- Compaction requires an LLM call (can fail, falls back to extraction)
- No parallel tool execution (sequential only)
- No multi-agent routing
- No structured output / JSON mode enforcement

---

## 2. LLM Providers

### Supported Providers

| Provider | Auth Methods | Models | Unique |
|----------|-------------|--------|--------|
| **Anthropic** | API Key (`sk-ant-*`) OR OAuth Token (`sk-ant-oat-*`) | Claude Opus, Sonnet, Haiku | OAuth lets you use Claude Pro/Max subscription |
| **OpenAI** | API Key | GPT-4o, GPT-4.1, o3-mini | — |
| **Ollama** | None (local) | Any Ollama model | Auto-discovered via `/api/show` |

### Features
- **Automatic failover**: Primary → fallback provider on timeout/429/500/network error
- **Exponential backoff**: Rate limit retry (max 3 attempts, 2^n + jitter)
- **Failover event log**: Last 50 failover events tracked
- **Model capabilities registry**: Context window, vision, tools, cost — per model
- **Ollama auto-discovery**: Context length, vision, tool support detected from running models via API
- **Admin-editable overrides**: Override any model's capabilities from the UI
- **Unknown model enforcement**: Must configure capabilities before activating
- **Credentials from admin UI**: API keys saved to unified SecretsStore, no file editing needed
- **Runtime reinitialization**: Provider registry rebuilds when credentials change

### Model Capabilities (built-in)

| Model | Context | Max Output | Vision | Cost (in/out per 1M) |
|-------|---------|-----------|--------|------|
| claude-opus-4-6 | 200K | 16K | Yes | $15/$75 |
| claude-sonnet-4-6 | 200K | 8K | Yes | $3/$15 |
| claude-haiku-4-5 | 200K | 8K | Yes | $0.8/$4 |
| gpt-4.1 | 1M | 32K | Yes | $2/$8 |
| gpt-4o | 128K | 16K | Yes | $2.5/$10 |
| gpt-4o-mini | 128K | 16K | Yes | $0.15/$0.6 |
| o3-mini | 200K | 100K | No | $1.1/$4.4 |

### Limitations
- No multi-model routing (cheap for classification, expensive for reasoning)
- No model switching mid-conversation (only via `/model` command)
- Anthropic/OpenAI model APIs don't expose capabilities — relies on hardcoded + user overrides
- No Google Gemini, Mistral, or other providers yet

---

## 3. Tool System

### Built-in Tools (10)

| Tool | Description | Security |
|------|-------------|----------|
| `read_file` | Read file with offset/limit | Path traversal + symlink protection |
| `write_file` | Create/write files (max 10MB) | Path traversal protection |
| `edit_file` | Find and replace exact text | Path traversal protection |
| `list_directory` | List files with sizes | Workspace-restricted |
| `exec` | Shell commands (max 120s timeout) | Env allowlist (only PATH, HOME, SHELL, etc.) |
| `web_fetch` | Fetch URL content (max 50K chars) | SSRF protection (blocks private IPs) |
| `web_search` | Brave Search API | Requires API key |
| `send_message` | Send to Telegram/WhatsApp/Web | Requires explicit target |
| `manage_cron` | Create/list/update/delete/run cron jobs | Validates delivery targets |
| `memory_search` | Semantic search over memory files | Top-N with relevance scoring |

### MCP (Model Context Protocol)
- Install tool servers from curated catalog or custom config
- Catalog includes: GitHub, Slack, Google Drive, Postgres, MySQL, and more
- Servers stored in config.json, secrets in unified secrets.json
- Auto-reconnect with exponential backoff (max 10 attempts, 60s max delay)
- Tool pinning: detects and warns when a server's tool set changes
- Dynamic tool registration: MCP tools appear alongside built-in tools
- Admin UI: one-click install, env var configuration, enable/disable, reconnect

### Tool Security
- **Exec**: environment allowlist (not denylist) — child processes get only PATH, HOME, SHELL, TERM, LANG, NODE_ENV, TZ
- **Files**: path traversal protection with symlink escape detection — restricted to workspace + /tmp
- **Web**: SSRF protection — blocks localhost, 10.x, 172.16-31.x, 192.168.x, 169.254.x, cloud metadata endpoints
- **Budget**: 10KB per tool result, 30KB total per round — prevents context overflow
- **Permissions**: RBAC per tool — allow, deny, or confirm (requires approval)
- **Audit**: every tool call recorded with name, args, result, status, duration

### Limitations
- No HTTP POST/PUT/PATCH tool (only GET via web_fetch)
- No email sending tool
- No PDF/document parsing tool
- No parallel tool execution
- Tool approval workflow UI not built (backend exists)
- No custom tool registration via API (only MCP or built-in)

---

## 4. Channels

### Telegram
- **Type**: Dedicated bot account via @BotFather
- **Messages**: Text, photo (→ vision), document, voice (saved to disk)
- **Groups**: Configurable — enable/disable, require @mention or reply
- **Allow-list**: By user/group ID
- **Hot-reload**: Enable/disable from admin UI without restart
- **AI images**: Agent can send images inline from responses

### WhatsApp
- **Type**: Linked device via QR code (uses your phone number)
- **Messages**: Text, image (→ vision), document, voice, video
- **Groups**: Configurable — enable/disable, require @mention or reply
- **LID resolution**: Handles WhatsApp's Linked Identity system transparently
- **Allow-list**: By phone number
- **Read receipts**: Configurable
- **Auto-reconnect**: Exponential backoff on disconnection
- **Hot-reload**: Enable/disable from admin UI without restart

### Web Chat
- **Type**: Built-in WebSocket (`/ws`)
- **Features**: Real-time streaming, multi-session, tool visualization
- **Auth**: API key authentication

### Limitations
- WhatsApp bot IS your phone number (no separate bot identity)
- WhatsApp uses unofficial Baileys protocol (can break on updates)
- Voice messages saved but not transcribed
- Documents saved but not parsed
- No Slack, Discord, or SMS channels yet

---

## 5. Cron & Scheduled Tasks

### Schedule Types
- `cron`: Standard 5-field expressions (e.g., `0 9 * * *` = daily 9 AM)
- `every`: Interval in milliseconds (minimum 5 seconds)
- `at`: One-shot at a specific ISO timestamp

### Features
- **Timezone support**: IANA timezones (e.g., `Asia/Singapore`)
- **Multi-channel delivery**: Per-target routing — different chat IDs per channel
- **Multi-platform**: Same job delivers to Telegram AND WhatsApp AND Web
- **Announce mode**: Agent generates text, scheduler delivers (no tool interference)
- **Validation**: Cron syntax, interval minimum, date format checked on creation
- **Auto-disable**: Jobs with missing delivery targets disabled with clear error
- **LLM-managed**: Agent can create/update/delete cron jobs via `manage_cron` tool
- **Admin UI**: Dynamic delivery target editor with per-channel inputs

### Heartbeat Service
- Periodic health check / keep-alive (configurable interval, default 30 min)
- Runs agent with monitoring prompt
- Alerts delivered to configured channel

### Limitations
- No run history (only last result per job)
- No failure alerting
- No model/persona override per job
- Maximum 50 jobs
- Minute-level granularity (not second-level)

---

## 6. Memory System

### Two-Layer Architecture

| Layer | File | Retention | Purpose |
|-------|------|-----------|---------|
| **Profile** | `memory/PROFILE.md` | Permanent | User identity, preferences, key facts |
| **Sessions** | `memory/sessions/YYYY-MM-DD.md` | 7 days | Daily conversation notes |

### Features
- **Smart deduplication**: Reads existing memory before saving — only NEW facts added
- **Skips non-conversations**: Cron and heartbeat sessions ignored
- **Consolidation**: Merges session notes into updated profile (manual or scheduled)
- **Auto-cleanup**: Expired session files deleted (>7 days)
- **System prompt injection**: Profile + last 3 days of sessions loaded at start of every conversation
- **Workspace memory search**: Semantic search over memory files with relevance scoring
- **Chunked indexing**: 400-token chunks with 80-token overlap for search

### Limitations
- No semantic/vector search (keyword-based only)
- No explicit `/remember` or `/forget` commands
- No memory management UI
- Consolidation must be triggered manually (no auto-schedule yet)

---

## 7. Observability

### Logging (Three Destinations)
1. **Terminal**: pino-pretty (colorized, human-readable)
2. **File**: `~/.agw/logs/server-YYYY-MM-DD.log` (daily rotation, 7-day retention)
3. **Ring buffer**: Last 1000 entries for admin UI

### Structured Categories
`llm`, `tool`, `mcp`, `channel.telegram`, `channel.whatsapp`, `channel.web`, `cron`, `memory`, `auth`, `config`, `http`, `system`

### LLM Metrics (per call)
- Model, provider, input/output tokens
- Latency (ms), cost estimate (USD)
- Stop reason (end_turn, tool_use, max_tokens)
- Round number, tool call count

### Admin UI
- **Live tab**: Real-time log view with level + category filters, auto-scroll
- **Search tab**: Full-text search across persisted log files with date range
- **Expandable entries**: Click any log to see full structured JSON
- **Log files list**: Available files with sizes
- **Runtime log level control**: Change verbosity without restart

### Usage Tracking
- Per-LLM-call recording: model, provider, tokens, cost
- Stored in SQLite `usage_records` table
- Cost estimation from model registry pricing

### Limitations
- Usage UI incomplete (data shape mismatch — Beta)
- No dashboard charts or graphs
- No cost budget / alerting
- No metrics export (Prometheus, etc.)

---

## 8. Security

### Authentication & Authorization
- API key authentication (Bearer token)
- Role-based access: admin, user, viewer
- Session ownership enforcement (non-admins see only their sessions)
- Login rate limiting with map cap and expiry eviction
- Runtime role validation (invalid DB roles rejected)

### Secrets Management
- **Unified SecretsStore** (`secrets.json`, mode 0600)
- Single file for ALL secrets: provider keys, MCP tokens, channel tokens, tool API keys
- Namespaced: `providers.anthropic`, `mcp.github`, `channels.telegram`, etc.
- Auto-migration from `.env` + `mcp-secrets.json` on first boot
- Credentials editable from admin UI (no file editing needed)

### Data Protection
- Exec tool: env allowlist — only safe variables passed to child processes
- Output redaction: 10+ secret patterns stripped from agent responses
- Path traversal protection on all file tools (with symlink check)
- SSRF protection on web_fetch (blocks private IP ranges)
- WebSocket session binding (no cross-session spoofing)
- Broadcast filtered by session key (no data leaks between clients)

### Audit Trail
- Tamper-evident hash chain: `entry_hash = hash(prev_hash + action + details)`
- Events: session.create, tool.execute, tool.denied, mcp.install, auth.login, config.update
- Chain integrity verification function

### Limitations
- No encryption at rest for secrets.json or SQLite
- No OAuth2/OIDC SSO
- No PII detection/redaction before LLM calls
- No token budgets or cost kill-switch
- Prompt injection detection is heuristic (flags, doesn't block)

---

## 9. Admin UI

### Pages (10)

| Group | Page | Purpose |
|-------|------|---------|
| **Configuration** | Dashboard | System overview |
| | Personas | Edit persona files (IDENTITY, SOUL, USER, AGENTS) |
| | Providers & Models | Credentials, test, set default/fallback, capabilities |
| | Channels | Enable/disable, configure, monitor Telegram + WhatsApp |
| | Settings | Agent, session, tools, heartbeat, raw JSON |
| | MCP Servers | Install, configure, enable/disable tool servers |
| **Operations** | Cron Jobs | Create/edit/delete with multi-target delivery |
| | Sessions | View conversations, messages, delete |
| | Logs | Live + search + expandable structured entries |
| | Usage (Beta) | Token usage and cost tracking |

### Design
- SvelteKit SPA with dark theme (warm indigo-black palette)
- Admin nav: two groups (Configuration + Operations) with SVG icons
- Hot-reload for channels (toggle, no restart)
- Inline forms for credentials, capabilities, delivery targets

### Limitations
- No mobile responsive design
- No light theme
- No onboarding wizard
- No command palette (Cmd+K)

---

## 10. Infrastructure

### Stack
- **Runtime**: Node.js + TypeScript
- **Framework**: Fastify (HTTP) + SvelteKit (UI)
- **Database**: SQLite via better-sqlite3 (10 tables, 5 migrations)
- **Monorepo**: pnpm workspaces — `@agw/types`, `@agw/core`, `@agw/ui`

### Deployment
- Single process, single `start.sh` command
- Docker support (Dockerfile + docker-compose)
- State directory: `~/.agw/` (config, secrets, database, logs, WhatsApp auth)
- Graceful shutdown (channels, scheduler, heartbeat, MCP, memory, DB)
- Process-level crash protection (uncaughtException/unhandledRejection caught)

### Limitations
- Single-tenant only (multi-tenant schema exists but not enforced)
- SQLite limits (~100 concurrent sessions)
- No horizontal scaling
- No zero-downtime restart

---

## What Makes AGW Different

### vs ChatGPT / Claude.ai
- **Self-hosted**: Complete control, zero vendor lock-in, your data stays local
- **Multi-channel**: Chat via Telegram, WhatsApp, Web — same agent, same memory
- **Tool automation**: File ops, shell exec, web fetch, MCP servers — all built-in
- **Proactive agents**: Cron jobs that run on schedule and deliver to your channels
- **Your subscription**: Use Claude Pro/Max OAuth token — no separate API billing

### vs OpenWebUI / LobeChat / LibreChat
- **Persistent layered memory**: Profile (permanent) + Sessions (7-day) — not just chat history
- **Context compaction**: LLM-based summarization when context fills up — not just truncation
- **Multi-provider failover**: Seamless switching between Anthropic, OpenAI, Ollama on errors
- **MCP integration**: Full Model Context Protocol support out-of-box
- **Cron + delivery**: Scheduled AI tasks with multi-channel delivery targets
- **Cost tracking**: Per-call cost estimation and recording
- **Audit trail**: Tamper-evident logging of all tool calls and actions
- **RBAC**: Tool-level permissions (allow/deny/confirm per role)
- **Unified secrets**: Single encrypted-permissions file for all API keys
