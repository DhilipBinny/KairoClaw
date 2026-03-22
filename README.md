<p align="center">
  <img src="assets/logo.png" alt="KairoClaw" width="600" />
</p>

<p align="center"><strong>Your AI, your rules.</strong></p>

<p align="center">
A self-hosted AI gateway that connects any LLM to your messaging channels, tools, and workflows.<br/>
One brain, every channel, zero vendor lock-in.
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="#gpu-services">GPU Services</a> &middot;
  <a href="#admin-dashboard">Admin Dashboard</a>
</p>

---

## What is KairoClaw?

KairoClaw is a personal AI assistant that lives where you already are &mdash; Telegram, WhatsApp, and a built-in web chat. It connects to any LLM (Claude, GPT-4o, or local models via Ollama), remembers your preferences across conversations, executes tools, runs scheduled tasks, and delivers results to your phone.

Think of it as your own private AI infrastructure: self-hosted, extensible, and under your control.

---

## Quickstart

### Docker (recommended)

```bash
git clone https://github.com/DhilipBinny/KairoClaw.git
cd KairoClaw
docker compose up -d
```

Open **http://localhost:18181** and follow the setup wizard.

### From source

```bash
git clone https://github.com/DhilipBinny/KairoClaw.git
cd KairoClaw
pnpm install
pnpm build
pnpm start
```

### First-run setup

1. Open the admin UI at `http://localhost:18181`
2. Go to **Providers** &rarr; paste your Anthropic or OpenAI API key
3. (Optional) Go to **Channels** &rarr; connect Telegram or WhatsApp
4. Start chatting

---

## Features

### Chat anywhere

Connect once, chat from everywhere. The same AI with the same memory across all channels.

| Channel | How it works |
|---------|-------------|
| **Web UI** | Built-in chat at `localhost:18181`. WebSocket-based, real-time streaming. |
| **Telegram** | Create a bot via @BotFather, paste the token. Supports groups, mentions, allowlists. |
| **WhatsApp** | Scan a QR code from the admin UI. No business API needed. Supports voice, images, documents. |
| **REST API** | `POST /api/v1/chat` for programmatic access. Sync and SSE streaming modes. |

### Use any LLM

| Provider | Models | Notes |
|----------|--------|-------|
| **Anthropic** | Claude Sonnet, Opus, Haiku | API key or OAuth (Claude Pro/Max subscription) |
| **OpenAI** | GPT-4o, GPT-4, o1, o3 | Standard API key |
| **Ollama** | Llama, Mistral, Gemma, etc. | Local models, no API key needed |

Automatic failover: configure a fallback chain so if one provider is down, the next one takes over.

### Tools

The agent can take actions, not just talk.

| Tool | What it does |
|------|-------------|
| `exec` | Run shell commands (sandboxed, timeout, allowlist env) |
| `read_file` / `write_file` / `edit_file` | Read, create, and modify files in the workspace |
| `web_fetch` | Fetch and extract content from URLs (SSRF-protected) |
| `web_search` | Search the web via Brave Search API |
| `send_message` | Proactively send messages to any channel |
| `manage_cron` | Create, list, update, delete scheduled jobs |
| `spawn_agent` | Run parallel sub-agents for complex multi-step tasks |
| `read_pdf` | Extract text from PDFs (pdftotext + OCR fallback) |
| `send_email` | Send emails via SMTP with rate limiting and domain restrictions |
| `inspect_image` | Read image file metadata |
| `memory_search` | Search across the agent's memory system |

### Plugins

Extend the agent with any CLI tool or HTTP API &mdash; no code required.

**CLI plugins** wrap any binary (git, gh, docker, kubectl, jq) with subcommand filtering and safety controls:

```json
{
  "name": "gh",
  "command": "gh",
  "allowedSubcommands": ["pr", "issue", "repo", "run"],
  "blockedSubcommands": ["auth", "ssh-key", "secret"]
}
```

**HTTP plugins** wrap any REST API with typed parameters, auth, and media handling:

```json
{
  "name": "currency",
  "baseUrl": "https://api.frankfurter.dev/v1",
  "endpoints": [
    { "name": "latest", "method": "GET", "path": "/latest", "parameters": { "base": { "type": "string" } } }
  ]
}
```

**OpenAPI auto-import**: point KairoClaw at any service with an `/openapi.json` endpoint and it auto-discovers and registers all tools:

```json
{
  "openapi": [
    { "name": "flux2", "baseUrl": "http://gpu-server:5006" },
    { "name": "whisper", "baseUrl": "http://gpu-server:5007" }
  ]
}
```

### MCP (Model Context Protocol)

Connect MCP servers for GitHub, Slack, databases, file systems, and more. Supports both stdio and SSE transports. Configure from the admin UI or `config.json`.

### Scheduled tasks

Cron jobs that run AI prompts on a schedule and deliver results to any channel.

```
"Every morning at 9am, summarize my GitHub notifications and send to Telegram"
"Every 3 hours, check the Bitcoin price and alert me on WhatsApp if it's above $100k"
```

Supports cron expressions, one-shot timers, and interval-based schedules. Multi-channel delivery with auto-filled addresses from the current conversation.

### Memory

The agent learns and remembers across conversations.

- **Session notes** &mdash; auto-extracted facts from each conversation, stored per-day
- **Long-term profile** &mdash; periodically consolidated from session notes into a permanent user profile
- **Per-user scoping** &mdash; each user gets isolated memory (separate profiles, separate session history)
- **Workspace files** &mdash; IDENTITY.md (who the agent is), SOUL.md (personality), USER.md (user info), RULES.md (behavioral rules)

### Voice transcription

Voice notes from Telegram and WhatsApp are automatically transcribed to text using a configurable OpenAI-compatible STT endpoint (e.g. self-hosted Whisper on GPU).

Configure in the admin UI under **Settings &rarr; Tools &rarr; Voice Transcription**.

### Security

- **RBAC** &mdash; role-based tool permissions (admin, user, viewer)
- **Audit trail** &mdash; tamper-evident hash chain of all actions
- **Secrets management** &mdash; encrypted secrets store, never in config files
- **Input sanitization** &mdash; prompt injection detection on all channels
- **Output filtering** &mdash; automatic redaction of API keys, tokens, passwords
- **Outbound policy** &mdash; control which contacts the bot can message
- **Rate limiting** &mdash; per-user API rate limits
- **SSRF protection** &mdash; URL validation with redirect checking on all fetch operations

---

## Architecture

```
                    Telegram ──┐
                    WhatsApp ──┤
                     Web UI ──┤    ┌─────────────┐    ┌──────────────┐
                    REST API ──┼───▶│  KairoClaw  │───▶│ LLM Provider │
                               │    │  (Fastify)  │    │ Claude/GPT/  │
                               │    │             │    │ Ollama       │
                               │    └──────┬──────┘    └──────────────┘
                               │           │
                               │     ┌─────┴─────┐
                               │     │           │
                               ▼     ▼           ▼
                           ┌──────┐ ┌────┐  ┌────────┐
                           │Tools │ │MCP │  │Plugins │
                           │exec  │ │Git │  │CLI/HTTP│
                           │files │ │DB  │  │OpenAPI │
                           │web   │ │... │  │        │
                           └──────┘ └────┘  └────────┘
```

**Monorepo structure:**

```
packages/
  core/       # Backend — Fastify server, agent loop, tools, channels, DB
  types/      # Shared TypeScript types
  ui/         # Frontend — SvelteKit admin dashboard + web chat
```

**Tech stack:**

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22, TypeScript |
| Server | Fastify |
| Frontend | SvelteKit |
| Database | SQLite (better-sqlite3) |
| Logging | Pino (structured JSON, file rotation, ring buffer) |
| Telegram | grammY |
| WhatsApp | Baileys (no business API needed) |
| Build | pnpm, Vite, Rollup |

---

## Configuration

KairoClaw stores its state in a data directory (`agw-data/` or `/data` in Docker):

```
agw-data/
  config.json        # Main configuration
  secrets.json       # Encrypted secrets (API keys, tokens)
  plugins.json       # CLI + HTTP + OpenAPI plugin definitions
  cron-jobs.json     # Scheduled tasks
  gateway.db         # SQLite database (sessions, messages, audit)
  workspace/         # Agent workspace (files, memory, personas)
    IDENTITY.md      # Who the agent is
    SOUL.md          # Agent personality
    USER.md          # User info
    RULES.md         # Behavioral rules
    MEMORY.md        # Memory index
    memory/          # Auto-generated session notes + profiles
    scopes/          # Per-user isolated workspaces
```

All settings are configurable from the admin UI. For headless setups, edit `config.json` directly.

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGW_PORT` | HTTP listen port | `18181` |
| `AGW_TOKEN` | Gateway auth token | (none) |
| `ANTHROPIC_API_KEY` | Anthropic API key | (none) |
| `OPENAI_API_KEY` | OpenAI API key | (none) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | (none) |
| `BRAVE_API_KEY` | Brave Search API key | (none) |
| `LOG_LEVEL` | Log level (debug/info/warn/error) | `info` |

Keys can also be set via the admin UI &rarr; Providers page, which stores them in the encrypted secrets store.

---

## GPU Services

For image generation and voice transcription, KairoClaw connects to self-hosted GPU services via OpenAI-compatible APIs.

See [`flux-and-speech/`](https://github.com/DhilipBinny/KairoClaw/tree/main/flux-and-speech) (separate repo) for the GPU services stack:

| Service | Port | What |
|---------|------|------|
| **Flux2** | 5006 | Image generation (Flux 2 Dev) &mdash; `/v1/images/generations` |
| **Whisper** | 5007 | Speech-to-text (faster-whisper) &mdash; `/v1/audio/transcriptions` |
| **Ollama** | 11434 | Local LLMs &mdash; `/v1/chat/completions` |

All services auto-discover via OpenAPI specs. Point KairoClaw at the base URL and tools are registered automatically.

---

## Admin Dashboard

The admin UI at `http://localhost:18181` provides:

| Page | What it does |
|------|-------------|
| **Chat** | Built-in web chat with session management |
| **Providers** | Configure LLM API keys and models |
| **Model** | Select primary model and fallback chain |
| **Channels** | Telegram/WhatsApp setup, status, and pending sender approval |
| **Sessions** | Browse and manage active chat sessions |
| **Plugins** | Add/edit CLI and HTTP plugins, OpenAPI imports |
| **MCP** | Configure MCP servers |
| **Cron** | View and manage scheduled jobs |
| **Personas** | Edit workspace files (IDENTITY, SOUL, USER, RULES) |
| **Settings** | Tool toggles, agent behavior, thinking mode, transcription |
| **Logs** | Real-time structured log viewer with category filtering |
| **Usage** | Token usage and cost tracking |

---

## Development

```bash
# Install dependencies
pnpm install

# Dev mode (hot reload)
pnpm dev

# Build for production
pnpm build

# Start production server
pnpm start

# Type-check
pnpm exec tsc --noEmit --project packages/core/tsconfig.json
```

---

## License

MIT
