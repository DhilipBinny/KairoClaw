<p align="center">
  <img src="assets/logo.png" alt="KairoClaw" width="500" />
</p>

<h3 align="center">Your AI, your rules.</h3>

<p align="center">
A self-hosted, multi-user AI operations platform.<br/>
One agent. Every channel. Full control.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node" />
  <img src="https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/PostgreSQL-supported-336791?logo=postgresql&logoColor=white" alt="PostgreSQL" />
</p>

<p align="center">
  <a href="#why-kairoclaw">Why</a> &nbsp;&middot;&nbsp;
  <a href="#get-started">Get Started</a> &nbsp;&middot;&nbsp;
  <a href="#features">Features</a> &nbsp;&middot;&nbsp;
  <a href="#multi-user">Multi-User</a> &nbsp;&middot;&nbsp;
  <a href="#tools--plugins">Tools</a> &nbsp;&middot;&nbsp;
  <a href="#security">Security</a> &nbsp;&middot;&nbsp;
  <a href="#docs">Docs</a>
</p>

<!-- TODO: Add demo GIF or screenshot -->
<!-- <p align="center"><img src="assets/demo.gif" alt="KairoClaw demo" width="800" /></p> -->

---

## Why KairoClaw

Most AI tools lock you into one chat window, one provider, one user. KairoClaw is different:

- **One conversation across every channel** — start on Telegram, continue on WhatsApp, finish on the web. Same memory, same context.
- **Your team, your rules** — add users with role-based permissions. Each person gets isolated memory and workspace.
- **Any provider, automatic failover** — Anthropic, OpenAI, Ollama. If one goes down, the next picks up. No code changes.
- **Self-hosted** — your data stays on your infrastructure. No third-party cloud dependency.

---

## Get Started

### Docker (recommended)

```bash
git clone https://github.com/DhilipBinny/KairoClaw.git
cd KairoClaw
docker compose up -d
```

Open **http://localhost:18181**, paste your API key, and start chatting. Works with **Anthropic** (Claude), **OpenAI** (GPT-4o), or **Ollama** (local models).

### Bare Metal

```bash
git clone https://github.com/DhilipBinny/KairoClaw.git
cd KairoClaw
./scripts/setup-local.sh
```

Creates a `kairo` CLI with `start`, `stop`, `restart`, `logs`, `build` commands. Requires Node.js 22+.

---

## Features

| Feature | What it does |
|---------|-------------|
| **Multi-Channel** | Telegram, WhatsApp, Web Chat — unified conversation across all channels |
| **Multi-Provider** | Anthropic (Claude), OpenAI (GPT-4o), Ollama (local) — auto-failover chain |
| **Multi-User** | Admin, Power User, User roles — per-user workspace, memory, permissions |
| **Smart Memory** | Auto-extracted user profile + session context. Cross-channel, per-user isolated |
| **Model Router** | Auto-selects fast/balanced/powerful model per message complexity. Save costs on simple messages |
| **Smart Compaction** | Two-stage context management — session notes as free compaction summary, eliminates redundant LLM calls |
| **20+ Built-in Tools** | Shell exec, file ops, web search/fetch, email, cron, sub-agents, PDF reader |
| **Plugin System** | MCP servers, CLI wrappers, HTTP APIs, OpenAPI auto-discovery — extend without code |
| **Cron Scheduling** | Cron, interval, one-shot tasks with multi-channel delivery |
| **Admin Dashboard** | 14 admin pages — providers, users, sessions, logs, usage, cron, plugins, settings |
| **Encrypted Secrets** | AES-256-GCM envelope encryption for all API keys and tokens |
| **Database** | SQLite (default) or PostgreSQL — auto-migration between them |
| **Model Indicator** | See which model responded per message — configurable per channel and role |

---

## Multi-User

Add your team, family, or clients. Each person gets isolated memory, files, and tool access.

| Role | Access |
|------|--------|
| **Admin** | Full dashboard, all tools unrestricted, manage users |
| **Power User** | All tools (sandboxed) — exec, file writes, cron with scoped access |
| **User** | Safe tools only — read files, search web, chat. No exec, no file writes |

**One person, all channels** — link Telegram + WhatsApp to the same user. One memory, one scope.

**Onboarding** — someone messages your bot? One click: create account, link channel, approve.

---

## Tools & Plugins

**20+ built-in tools** — file read/write/edit, shell exec, web search/fetch, email, messaging, cron, memory search, sub-agents, PDF reader, image inspection.

**Tool permissions** per role from Settings:

| Level | Effect |
|---|---|
| Allow | Available to all users |
| Power User only | Admin + Power User flag required |
| Confirm first | Agent asks before executing |
| Deny | Hidden from agent, blocked at execution |

**Extend with plugins** — no code required:

| Type | What it does | Example |
|------|-------------|---------|
| **MCP** | Model Context Protocol servers | GitHub, Slack, Postgres |
| **CLI** | Wraps any binary with safety controls | `gh`, `docker`, `kubectl`, `jq` |
| **HTTP** | Wraps any REST API with typed params | Currency API, image generation |
| **OpenAPI** | Auto-discovers tools from spec | Self-hosted GPU services |

---

## Security

| Layer | What it does |
|---|---|
| **Encryption at rest** | AES-256-GCM envelope encryption for all API keys and secrets |
| **Scope isolation** | File tools, exec, and memory enforce per-user boundaries |
| **Tool RBAC** | DB-driven, admin-configurable, double-enforced (prompt + execution) |
| **Exec sandboxing** | Admin = unrestricted, Power User = sandboxed, User = denied |
| **Output redaction** | API keys, tokens, secrets auto-stripped from agent responses |
| **Audit trail** | Tamper-evident hash chain on all tool calls and admin actions |

---

## Admin Dashboard

14 admin pages + 4 user portal pages.

| Admin | User Portal (`/my/`) |
|---|---|
| Dashboard, Personas, Providers & Models | Dashboard |
| Channels, Users, Settings | My Sessions |
| MCP Servers, Plugins | My Usage |
| Cron Jobs, Sessions, Scoped Channels | My Cron Jobs |
| Logs, Usage, Database | |

---

## Docs

| Document | Description |
|---|---|
| [Multi-User Guide](docs/MULTI-USER.md) | Roles, onboarding, tool permissions, user workspace |
| [Architecture](docs/MULTI-USER-ARCHITECTURE.md) | Scope isolation, permission pipeline, design decisions |
| [Channels](docs/CHANNELS.md) | Telegram, WhatsApp, Web Chat — setup, features, constraints |
| [Database](docs/DATABASE.md) | SQLite vs PostgreSQL, migration, Docker Compose |
| [Memory](docs/MEMORY.md) | Auto-memory system, per-user scoping, consolidation |
| [Product Features](docs/PRODUCT_FEATURES.md) | Complete feature inventory with metrics |

---

<p align="center">
  <strong>MIT License</strong><br/>
  Built with TypeScript, Fastify, SvelteKit, SQLite, and PostgreSQL.
</p>
