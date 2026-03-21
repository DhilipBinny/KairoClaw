/**
 * Product-level constants — centralized configuration.
 *
 * Everything that controls product behavior lives here.
 * Edit this file to tune limits, safety rules, and defaults.
 * User-configurable settings are in config.json / admin UI.
 * These are hardcoded product decisions.
 */

// ── Safety Rules (injected into every system prompt) ────────
// These cannot be overridden by the user via RULES.md or admin UI.

export const SAFETY_RULES = [
  'Do not pursue self-preservation, replication, or power-seeking.',
  'Prioritize safety and human oversight over task completion.',
  'Do not run destructive commands without asking first.',
  'Private information stays private.',
  'When in doubt, ask.',
];

// ── Agent Loop ──────────────────────────────────────────────

/** Max tool-call rounds per agent turn (overridden by config.agent.maxToolRounds) */
export const DEFAULT_MAX_TOOL_ROUNDS = 25;

/** Max chars per individual tool result before truncation */
export const MAX_TOOL_RESULT_CHARS = 10_000;

/** Max total chars for all tool results per round */
export const MAX_TOTAL_TOOL_RESULTS = 30_000;

// ── Compaction ──────────────────────────────────────────────

/** Context usage ratio that triggers compaction (overridden by config.agent.compactionThreshold) */
export const DEFAULT_COMPACTION_THRESHOLD = 0.75;

/** Messages to keep after compaction (overridden by config.agent.keepRecentMessages) */
export const DEFAULT_KEEP_RECENT_MESSAGES = 10;

// ── Memory ──────────────────────────────────────────────────

/** Days to keep session memory files before cleanup */
export const MEMORY_SESSION_RETENTION_DAYS = 7;

/** Minimum user turns before auto-memory triggers */
export const MEMORY_MIN_TURNS = 3;

/** Max chars of conversation text sent for memory extraction */
export const MEMORY_MAX_CONVERSATION_CHARS = 8_000;

/** Max chars of profile loaded into system prompt */
export const MEMORY_PROFILE_MAX_CHARS = 3_000;

/** Max chars per session file loaded into system prompt */
export const MEMORY_SESSION_MAX_CHARS = 1_500;

/** Number of recent session days to include in system prompt */
export const MEMORY_RECENT_DAYS = 3;

// ── Tools ───────────────────────────────────────────────────

/** Max stdout returned from exec tool */
export const EXEC_MAX_STDOUT = 10 * 1024;

/** Max stderr returned from exec tool */
export const EXEC_MAX_STDERR = 5 * 1024;

/** Max timeout for exec tool (seconds) */
export const EXEC_MAX_TIMEOUT_SECONDS = 120;

/** Default timeout for exec tool (seconds) */
export const EXEC_DEFAULT_TIMEOUT_SECONDS = 30;

/** Max file write size */
export const FILE_MAX_WRITE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Max chars returned from web_fetch */
export const WEB_FETCH_MAX_CHARS = 50_000;

/** Max workspace file size for persona editing (admin UI) */
export const WORKSPACE_MAX_FILE_SIZE = 1_000_000; // 1 MB

// ── System Prompt ───────────────────────────────────────────

/** Max chars per workspace file injected into system prompt */
export const PROMPT_MAX_FILE_CHARS = 20_000;

/** Workspace files loaded into every system prompt */
export const PROMPT_BOOTSTRAP_FILES = [
  'RULES.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
];

// ── Logging ─────────────────────────────────────────────────

/** In-memory ring buffer capacity */
export const LOG_BUFFER_CAPACITY = 1_000;

/** Days to keep rotated log files */
export const LOG_RETENTION_DAYS = 7;

// ── Cron ────────────────────────────────────────────────────

/** Maximum number of cron jobs */
export const CRON_MAX_JOBS = 50;

/** Minimum interval for 'every' type jobs (ms) */
export const CRON_MIN_INTERVAL_MS = 5_000;

// ── Media ────────────────────────────────────────────────────

/** Days to keep generated media files before auto-cleanup */
export const MEDIA_RETENTION_DAYS = 7;

/** Cleanup interval (6 hours) */
export const MEDIA_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ── Agent Loop Guards ────────────────────────────────────────

/** Max times the same tool+args can be called before loop detection triggers */
export const TOOL_LOOP_THRESHOLD = 3;

/** Max sub-agent nesting depth (1 = main can spawn workers, workers can't spawn) */
export const SUBAGENT_MAX_DEPTH = 1;

// ── Scoped Memory ───────────────────────────────────────────

/** Directory name for user scopes under workspace */
export const SCOPE_DIR_NAME = 'scopes';

/** Files that are ALWAYS global (never overridden per scope) */
export const GLOBAL_ONLY_FILES = ['RULES.md', 'IDENTITY.md', 'TOOLS.md'];

/** Files that cascade: scope override → global fallback */
export const CASCADING_FILES = ['SOUL.md', 'USER.md', 'MEMORY.md'];

/** Channels that get scoped memory */
export const SCOPED_CHANNELS = ['telegram', 'whatsapp'];

// ── PDF ─────────────────────────────────────────────────────

/** Maximum pages to extract from a PDF */
export const PDF_MAX_PAGES = 50;

/** Minimum chars per page before OCR fallback triggers */
export const PDF_OCR_MIN_CHARS_PER_PAGE = 50;

/** Timeout for PDF extraction commands (ms) */
export const PDF_TIMEOUT_MS = 60_000;

// ── Rate Limiting ───────────────────────────────────────────

/** Global HTTP rate limit (requests per minute) */
export const RATE_LIMIT_MAX = 300;

/** Login rate limit map max size before eviction */
export const LOGIN_MAP_MAX_SIZE = 10_000;
