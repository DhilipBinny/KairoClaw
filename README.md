<p align="center">
  <img src="assets/logo.png" alt="Kairo" width="600" />
</p>

<p align="center"><em>Your AI, your rules.</em></p>

A self-hosted AI gateway that connects any LLM to your messaging channels, tools, and workflows. One brain, every channel, zero vendor lock-in.

## Get Started

```bash
pnpm install && ./scripts/start.sh
```

Or with Docker:

```bash
docker compose up -d
```

Then open **http://localhost:18181** and add your API key from the admin UI.

## What It Does

- **Chat anywhere** — Web UI, Telegram bot, WhatsApp (QR pairing). Same AI, same memory, all channels.
- **Use any LLM** — Anthropic, OpenAI, or Ollama (local). Automatic failover between providers.
- **Call tools** — Files, shell, web search, APIs. Plus MCP servers for GitHub, Slack, databases, and more.
- **Schedule tasks** — Cron jobs that run AI prompts and deliver results to any channel.
- **Remember everything** — Auto-learns your preferences. Long-term profile + 7-day session notes.
- **Stay in control** — Admin dashboard, structured logs, audit trail, RBAC, secrets management.

## Tech

Node.js · TypeScript · Fastify · SvelteKit · SQLite · Pino

## License

MIT
