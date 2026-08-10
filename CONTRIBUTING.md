# Contributing to KairoClaw

Thanks for your interest in contributing! KairoClaw is an open-source project and we welcome contributions of all kinds.

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker (for sandbox execution features)

### Development Setup

```bash
git clone https://github.com/DhilipBinny/KairoClaw.git
cd KairoClaw
pnpm install
pnpm build
pnpm test
```

### Running Locally

```bash
# Dev server with hot-reload
pnpm dev:v2

# Or with Docker
docker compose up -d
```

## Project Structure

KairoClaw is a pnpm monorepo with 18 packages:

```
packages/
  types/             Shared TypeScript interfaces (build first)
  core/              Main server — routes, channels, agent wiring
  agent-core/        Agent loop, compaction, prompt building
  provider-bridge/   LLM provider abstraction
  tool-platform/     Tool registry and permissions
  tools-common/      Built-in tool implementations
  security/          Input sanitization, secret redaction
  database/          SQLite + PostgreSQL adapters
  cron/              Job scheduler
  memory-engine/     Auto-memory and session memory
  plugins/           Plugin coordinator (CLI, HTTP, MCP)
  ui/                Admin dashboard (SvelteKit)
  ...and more
```

**Build order**: `types` must build first, then all others can build in parallel. `core` depends on everything.

```bash
pnpm build          # Build all packages
pnpm test           # Run all tests (vitest)
pnpm lint           # ESLint on core + types
```

## Making Changes

### Branch Naming

- `feat/description` — new features
- `fix/description` — bug fixes
- `docs/description` — documentation
- `refactor/description` — code improvements

### Commit Messages

We use conventional commits:

```
feat: add webhook alert delivery
fix: prevent cron double-fire within same minute
docs: update README feature list
refactor: extract alert state machine
```

- Imperative mood ("add" not "added")
- Subject line under 72 characters
- Body for the "why" when it's not obvious

### Pull Requests

Every PR is reviewed against this checklist before merging:

1. **Correctness** — does it work? Edge cases? SQL works for both SQLite and PostgreSQL?
2. **Stability** — breaks production? Silent regressions? Backward-compatible?
3. **Modularity** — properly modularized? No copy-paste between packages?
4. **Constants** — no magic numbers; use per-package constants files
5. **Design alignment** — follows existing patterns?

### Testing

- New features need tests
- Bug fixes need regression tests
- Run `pnpm test` before pushing
- Tests use vitest with colocated `__tests__/` directories

### Code Style

- TypeScript strict mode
- No `console.log` — use `@agw/logger`
- No `as any` without justification
- Parameterized SQL everywhere (no string interpolation)
- Each package owns its constants

## Reporting Issues

- **Bugs**: use the bug report template
- **Features**: use the feature request template
- **Security**: see [SECURITY.md](SECURITY.md) — do NOT open public issues

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
