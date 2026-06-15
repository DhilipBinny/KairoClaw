/**
 * Core package constants — values used within @agw/core only.
 *
 * Other packages (agent-core, tools-common, memory-engine, cron, plugins)
 * own their own constants. Do NOT re-export values here that are consumed
 * by other packages — that creates dead exports and drift risk.
 */

// ── Agent Loop ──────────────────────────────────────────────

export const MAX_TOOL_RESULT_CHARS = 10_000;
export const MAX_TOTAL_TOOL_RESULTS = 30_000;

// ── Agent Loop Guards ────────────────────────────────────────

export const TOOL_LOOP_THRESHOLD = 3;

// ── Workspace ──────────────────────────────────────────────

export const WORKSPACE_MAX_FILE_SIZE = 1_000_000; // 1 MB

// ── Scoped Memory ───────────────────────────────────────────

export const SCOPE_DIR_NAME = 'scopes';
export const SHARED_DIR = 'shared';

// ── Pending Senders ─────────────────────────────────────────

export const PENDING_SEEN_CAP = 5;
export const PENDING_PENDING_CAP = 20;

// ── Media ────────────────────────────────────────────────────

export const MEDIA_RETENTION_DAYS = 7;
export const MEDIA_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SQLITE_BACKUP_RETENTION = 7;
export const SQLITE_BACKUP_STARTUP_DELAY_MS = 30_000;
/**
 * Lifetime of a signed media URL. Matched to the retention window so a signed
 * link stays valid for as long as the file exists but no longer.
 */
export const MEDIA_URL_TTL_MS = MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// ── Anthropic API ───────────────────────────────────────────

export const ANTHROPIC_API_VERSION = '2023-06-01';

// ── Sub-Agents ──────────────────────────────────────────────

export const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_IN_TURN_SUBAGENTS = 10;

// ── Rate Limiting ───────────────────────────────────────────

export const RATE_LIMIT_MAX = 300;
export const LOGIN_MAP_MAX_SIZE = 10_000;

// Failed API-key authentications allowed per client IP per window before further
// attempts are rejected. Applies to the Bearer/?token= auth path (not just the
// login route), so key-guessing can't bypass the login limiter via other routes.
export const AUTH_FAIL_RATE_LIMIT = 20;
export const AUTH_FAIL_RATE_WINDOW_MS = 60_000;

// ── Alerts ─────────────────────────────────────────────────

export const ALERT_GROUP_WAIT_MS = 30_000;
export const ALERT_COOLDOWN_CRITICAL_MS = 60 * 60 * 1000;
export const ALERT_COOLDOWN_WARNING_MS = 6 * 60 * 60 * 1000;
export const ALERT_REPEAT_CRITICAL_MS = 4 * 60 * 60 * 1000;
export const ALERT_REPEAT_WARNING_MS = 24 * 60 * 60 * 1000;
export const ALERT_RESOLUTION_DELAY_MS = 5 * 60 * 1000;
export const ALERT_FAILURE_THRESHOLD = 2;
export const ALERT_RECOVERY_THRESHOLD = 3;
export const ALERT_HEALTH_PROBE_INTERVAL_MS = 60_000;
export const ALERT_PROVIDER_PROBE_INTERVAL_MS = 5 * 60 * 1000;
export const ALERT_HISTORY_RETENTION_DAYS = 30;
export const ALERT_MAX_INSTANCES = 200;
export const ALERT_WEBHOOK_TIMEOUT_MS = 10_000;
export const ALERT_WEBHOOK_MAX_RETRIES = 3;
