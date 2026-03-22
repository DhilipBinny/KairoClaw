<p align="center">
  <img src="assets/logo.png" alt="KairoClaw" width="500" />
</p>

<h3 align="center">Your AI, your rules.</h3>

<p align="center">
A self-hosted AI assistant that lives in your Telegram, WhatsApp, and web browser.<br/>
One brain. Every channel. Zero vendor lock-in.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node" />
  <img src="https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
</p>

<p align="center">
  <a href="#highlights">Highlights</a> &nbsp;&middot;&nbsp;
  <a href="#get-started">Get Started</a> &nbsp;&middot;&nbsp;
  <a href="#admin-dashboard">Dashboard</a> &nbsp;&middot;&nbsp;
  <a href="#extend-with-plugins">Plugins</a> &nbsp;&middot;&nbsp;
  <a href="#documentation">Docs</a>
</p>

<!-- TODO: Add demo GIF or screenshot -->
<!-- <p align="center"><img src="assets/demo.gif" alt="KairoClaw demo" width="800" /></p> -->

---

<br/>

> You want an AI assistant that works from your phone, remembers what you told it last week, runs commands on your server, and texts you a morning briefing at 9am.
>
> **That's KairoClaw.** Connect any LLM to the apps you already use — and give it tools, memory, and a schedule.

<br/>

## Highlights

&#128172; **Chat from anywhere** &nbsp;&mdash;&nbsp; Telegram, WhatsApp, web chat. Same AI, same memory, all channels. Scan a QR. Paste a token. Done.

&#9881;&#65039; **It actually does things** &nbsp;&mdash;&nbsp; Shell commands, file ops, web search, emails, GitHub PRs, any REST API. Drop in a plugin to add more.

&#9200; **It works while you sleep** &nbsp;&mdash;&nbsp; Schedule tasks in plain English. *"Summarize my GitHub notifications every morning and send to Telegram."*

&#129504; **It remembers you** &nbsp;&mdash;&nbsp; Auto-extracts preferences, decisions, context. Builds a long-term profile. Per-user isolated memory.

&#127908; **It speaks your language** &nbsp;&mdash;&nbsp; Voice notes transcribed instantly via self-hosted Whisper. The AI responds as if you typed it.

&#128274; **Your data stays yours** &nbsp;&mdash;&nbsp; Self-hosted. Local models via Ollama. Nothing leaves your network unless you choose it.

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

## Admin dashboard

Manage everything from a single web UI — providers, channels, tools, scheduled tasks, sessions, logs, and personas.

<!-- TODO: Add screenshot: assets/admin-dashboard.png -->

<br/>

## Extend with plugins

Add any tool without writing code.

| Type | What it does | Example |
|------|-------------|---------|
| **CLI** | Wraps any binary with safety controls | `gh`, `docker`, `kubectl`, `jq` |
| **HTTP** | Wraps any REST API with typed params and auth | Currency API, image generation |
| **OpenAPI** | Auto-discovers tools from `/openapi.json` | Self-hosted GPU services |

<br/>

## Documentation

Detailed docs are in the [docs/](docs/) folder:
**Configuration** · **Channels** · **Plugins** · **Security** · **Architecture**

<br/>

---

<p align="center">
  <strong>MIT License</strong><br/>
  Built with TypeScript, Fastify, SvelteKit, and SQLite.
</p>
