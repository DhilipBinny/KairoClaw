// ── Config defaults ─────────────────────────────
export const DEFAULT_IMAGE = 'kairoclaw-sandbox:full';
export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';
export const DEFAULT_CPU = 1;
export const DEFAULT_MEMORY_MB = 512;
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const DEFAULT_MAX_LIFETIME_MINUTES = 240;
export const DEFAULT_PIDS_LIMIT = 256;

// ── Container naming + labels ───────────────────
export const CONTAINER_PREFIX = 'kairoclaw-sandbox';
export const CONTAINER_LABEL_KEY = 'kairoclaw.sandbox';
export const CONTAINER_USER_LABEL = 'kairoclaw.sandbox.user';
export const CONTAINER_SESSION_LABEL = 'kairoclaw.sandbox.session';

// ── Container paths ─────────────────────────────
export const CONTAINER_WORKSPACE_PATH = '/workspace';
export const CONTAINER_SHARED_PATH = '/shared';
export const CONTAINER_PERSONA_PATH = '/persona';

// ── Exec output limits ──────────────────────────
export const MAX_STDOUT = 10 * 1024;
export const MAX_STDERR = 5 * 1024;

// ── Lifecycle timers ────────────────────────────
export const IDLE_CLEANUP_INTERVAL_MS = 60_000;
export const IDLE_TIMEOUT_MS = 15 * 60_000;

// ── Container limits ────────────────────────────
export const MAX_CONTAINERS_PER_USER = 5;
export const MAX_CONTAINERS_TOTAL = 30;

// ── Mount resolver ──────────────────────────────
export const PERSONA_FILES = ['IDENTITY.md', 'SOUL.md', 'RULES.md'];

// ── Network allowlist (balanced tier, future proxy sidecar) ──
export const DEFAULT_NETWORK_ALLOWLIST = [
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'deb.debian.org',
  'security.debian.org',
  'github.com',
  'gitlab.com',
  'api.openai.com',
  'api.anthropic.com',
];
