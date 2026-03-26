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
  <a href="#highlights">Highlights</a> &nbsp;&middot;&nbsp;
  <a href="#get-started">Get Started</a> &nbsp;&middot;&nbsp;
  <a href="#multi-user">Multi-User</a> &nbsp;&middot;&nbsp;
  <a href="#tools--plugins">Tools</a> &nbsp;&middot;&nbsp;
  <a href="#security">Security</a> &nbsp;&middot;&nbsp;
  <a href="#documentation">Docs</a>
</p>

<!-- TODO: Add demo GIF or screenshot -->
<!-- <p align="center"><img src="assets/demo.gif" alt="KairoClaw demo" width="800" /></p> -->

---

<br/>

> Deploy one instance. Add your team. Everyone gets their own memory, files, and permissions — but shares the same AI brain.
>
> Chat from Telegram. Reply from WhatsApp. Continue on the web. It's all one conversation.

<br/>

## Highlights

| | Feature | |
|---|---|---|
| **Channels** | Telegram, WhatsApp, Web Chat | Same AI, same memory, all channels |
| **Multi-User** | Admin, Power User, User roles | Per-user workspace, memory, permissions |
| **Tools** | 19 built-in + MCP + CLI + HTTP + OpenAPI plugins | Shell, files, web, email, cron, sub-agents |
| **Memory** | Auto-extracted long-term profile + daily sessions | Per-user isolated, cross-channel unified |
| **Scheduling** | Cron, interval, one-shot | Multi-channel delivery, per-user ownership |
| **Providers** | Anthropic, OpenAI, Ollama | Auto-failover, cost tracking, per-user usage |
| **Security** | AES-256-GCM secrets, scope isolation, RBAC | Tamper-evident audit trail |
| **Database** | SQLite (default) or PostgreSQL | Auto-migration between them |

<br/>

## Get started

```bash
git clone https://github.com/DhilipBinny/KairoClaw.git
cd KairoClaw
docker compose up -d
```

Open **http://localhost:18181**, paste your API key, and start chatting.

Works with **Anthropic** (Claude), **OpenAI** (GPT-4o), or **Ollama** (local models). Automatic failover between providers.

<details>
<summary>Install from source</summary>

<br/>

```bash
pnpm install && pnpm build && pnpm start
```

Requires Node.js 22+.

</details>

<br/>

## Multi-User

Add your team, family, or clients. Each person gets isolated memory, files, and tool access.

| Role | What they can do |
|------|-----------------|
| **Admin** | Everything — full dashboard, all tools unrestricted, manage users |
| **Power User** | All tools (sandboxed) — exec, file writes, cron jobs with scoped access |
| **User** | Safe tools only — read files, search web, chat. No exec, no file writes |

**One person, all channels** — link a Telegram account AND WhatsApp number to the same user. One memory, one scope, regardless of channel.

**Onboarding** — someone messages your bot? One click: create account + link channel + approve. They get an API key for web chat too.

See [Multi-User docs](docs/MULTI-USER.md) for the full guide.

<br/>

## Admin Dashboard

14 admin pages + 4 user portal pages.

| Admin pages | User portal (`/my/`) |
|---|---|
| Dashboard, Personas, Providers & Models | Dashboard |
| Channels, Users, Settings | My Sessions |
| MCP Servers, Plugins | My Usage |
| Cron Jobs, Sessions, Scoped Channels | My Cron Jobs |
| Logs, Usage, Database | |

Non-admin users see "My Dashboard" in the sidebar. Admin sees the full admin panel.

<br/>

## Tools & Plugins

**19 built-in tools** — file read/write/edit, shell exec, web search/fetch, email, messaging, cron, memory search, sub-agents, PDF reader, image inspection.

**Tool permissions** — admin configures per role from Settings:

| Level | Effect |
|---|---|
| Allow | Available to all users |
| Power User only | Admin + users with Power User flag |
| Confirm first | Agent asks before executing |
| Deny | Hidden from agent, blocked at execution |

**Extend with plugins** — no code required:

| Type | What it does | Example |
|------|-------------|---------|
| **MCP** | Model Context Protocol servers | GitHub, Slack, Postgres |
| **CLI** | Wraps any binary with safety controls | `gh`, `docker`, `kubectl`, `jq` |
| **HTTP** | Wraps any REST API with typed params | Currency API, image generation |
| **OpenAPI** | Auto-discovers tools from `/openapi.json` | Self-hosted GPU services |

<br/>

## Security

| Layer | What it does |
|---|---|
| **Encryption at rest** | AES-256-GCM envelope encryption for all API keys and secrets |
| **Per-user scope isolation** | File tools, exec, and memory search enforce user boundaries |
| **Tool RBAC** | DB-driven, admin-configurable, double-enforced (prompt + execution) |
| **Exec sandboxing** | Admin = unrestricted, Power User = sandboxed, User = denied |
| **Output redaction** | API keys, tokens, secrets auto-stripped from agent responses |
| **Audit trail** | Tamper-evident hash chain on all tool calls and admin actions |
| **Deactivation** | Instant lockout across API, WebSocket, and channels |

<br/>

## Documentation

| Document | Description |
|---|---|
| [Multi-User Guide](docs/MULTI-USER.md) | Roles, onboarding, tool permissions, user workspace |
| [Architecture](docs/MULTI-USER-ARCHITECTURE.md) | Scope isolation, permission pipeline, design decisions |
| [Channels](docs/CHANNELS.md) | Telegram, WhatsApp, Web Chat — setup, features, constraints |
| [Database](docs/DATABASE.md) | SQLite vs PostgreSQL, migration, Docker Compose |
| [Memory](docs/MEMORY.md) | Auto-memory system, per-user scoping, consolidation |
| [Constraints](docs/CONSTRAINTS.md) | Outbound security, LID resolution, tool guardrails |
| [Product Features](docs/PRODUCT_FEATURES.md) | Complete feature inventory with metrics |

<br/>

---

<p align="center">
  <strong>MIT License</strong><br/>
  Built with TypeScript, Fastify, SvelteKit, SQLite, and PostgreSQL.
</p>
