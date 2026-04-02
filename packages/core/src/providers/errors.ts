/**
 * Centralized LLM error classification.
 *
 * Maps raw API errors to typed recovery actions. Used by the provider
 * registry (retry/failover decisions) and the agent loop (reactive compact).
 *
 * Inspired by Claude Code's error classification in services/api/errors.ts
 * which classifies every API error into a type with a specific recovery path.
 */

import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('llm');

// ─── Error types ────────────────────────────────────────────

export type ErrorType =
  | 'rate_limit'        // 429 — too many requests
  | 'overloaded'        // 529 — server capacity exceeded
  | 'prompt_too_long'   // Context overflow — needs compaction
  | 'auth_error'        // 401 — invalid/expired credentials
  | 'timeout'           // Request timed out
  | 'connection_error'  // Network failure (ECONNRESET, EPIPE, etc.)
  | 'server_error'      // 500/502/503 — provider-side issue
  | 'invalid_request'   // 400 — malformed request (don't retry)
  | 'unknown'           // Unclassified

export type RecoveryAction =
  | 'retry_with_backoff'    // Wait and try same provider again
  | 'retry_immediately'     // Retry without delay (stale connection)
  | 'failover'              // Switch to fallback provider
  | 'compact_and_retry'     // Reduce context, then retry
  | 'reauth'                // Credentials need refresh
  | 'give_up'               // Non-recoverable, return error to user

export interface ClassifiedError {
  type: ErrorType;
  action: RecoveryAction;
  retriable: boolean;
  status?: number;
  message: string;
  /** Suggested delay in ms before retry (0 = immediate) */
  retryDelayMs: number;
  /** Human-friendly message for the user (when action is 'give_up') */
  userMessage?: string;
}

// ─── Classification ─────────────────────────────────────────

/**
 * Classify an LLM API error into a typed error with a recovery action.
 *
 * @param error   The caught error (Error, API error with status, or unknown)
 * @param attempt Current retry attempt (0-based, for backoff calculation)
 */
export function classifyError(error: unknown, attempt = 0): ClassifiedError {
  const err = error as Error & { status?: number; code?: string; headers?: Record<string, string> };
  const message = err?.message || String(error);
  const status = err?.status;

  // ── Rate limit (429) ──────────────────────────────────
  if (
    status === 429 ||
    /rate.limit|too many requests|429/i.test(message)
  ) {
    const retryAfter = err?.headers?.['retry-after'];
    const delay = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : getBackoffDelay(attempt);

    return {
      type: 'rate_limit',
      action: 'retry_with_backoff',
      retriable: true,
      status: 429,
      message,
      retryDelayMs: delay,
    };
  }

  // ── Server overloaded (529) ───────────────────────────
  if (
    status === 529 ||
    /overloaded|capacity|529/i.test(message)
  ) {
    return {
      type: 'overloaded',
      action: 'retry_with_backoff',
      retriable: true,
      status: 529,
      message,
      retryDelayMs: getBackoffDelay(attempt, 2000), // longer base delay
    };
  }

  // ── Prompt too long (context overflow) ────────────────
  if (
    /prompt is too long|maximum context length|context.length|context.window|too.many.tokens|exceeds.*max.*token|max.*token.*exceeded/i.test(message)
  ) {
    return {
      type: 'prompt_too_long',
      action: 'compact_and_retry',
      retriable: true,
      status,
      message,
      retryDelayMs: 0,
      userMessage: 'Your conversation is too long. Compacting context and retrying...',
    };
  }

  // ── Auth error (401) ──────────────────────────────────
  if (
    status === 401 ||
    /unauthorized|invalid.*key|invalid.*token|auth.*error|invalid bearer/i.test(message)
  ) {
    return {
      type: 'auth_error',
      action: 'give_up',
      retriable: false,
      status: 401,
      message,
      retryDelayMs: 0,
      userMessage: 'Authentication failed. Please check your API key or token configuration.',
    };
  }

  // ── Timeout ───────────────────────────────────────────
  if (
    err?.name === 'AbortError' ||
    /timed? ?out|timeout|ETIMEDOUT/i.test(message)
  ) {
    return {
      type: 'timeout',
      action: 'failover',
      retriable: true,
      status,
      message,
      retryDelayMs: 0,
    };
  }

  // ── Connection error ──────────────────────────────────
  if (
    /ECONNRESET|ECONNREFUSED|EPIPE|ENETUNREACH|ENOTFOUND|socket hang up|network/i.test(
      err?.code || message,
    )
  ) {
    // ECONNRESET = stale connection, retry immediately
    const isStale = /ECONNRESET|EPIPE/i.test(err?.code || message);
    return {
      type: 'connection_error',
      action: isStale ? 'retry_immediately' : 'failover',
      retriable: true,
      status,
      message,
      retryDelayMs: isStale ? 0 : getBackoffDelay(attempt),
    };
  }

  // ── Server error (5xx) ────────────────────────────────
  if (status && status >= 500 && status < 600) {
    return {
      type: 'server_error',
      action: 'failover',
      retriable: true,
      status,
      message,
      retryDelayMs: getBackoffDelay(attempt),
    };
  }

  // ── Invalid request (400) ─────────────────────────────
  if (status === 400) {
    return {
      type: 'invalid_request',
      action: 'give_up',
      retriable: false,
      status: 400,
      message,
      retryDelayMs: 0,
      userMessage: 'The request was malformed. This may be a bug — please try again.',
    };
  }

  // ── Unknown ───────────────────────────────────────────
  return {
    type: 'unknown',
    action: 'give_up',
    retriable: false,
    status,
    message,
    retryDelayMs: 0,
  };
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Calculate exponential backoff delay with jitter.
 * @param attempt  0-based attempt number
 * @param baseMs   Base delay in ms (default 1000)
 * @param maxMs    Maximum delay cap (default 30000)
 */
export function getBackoffDelay(attempt: number, baseMs = 1000, maxMs = 30000): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseMs * 0.5;
  return Math.min(exponential + jitter, maxMs);
}

/**
 * Log a classified error with structured metadata.
 */
export function logClassifiedError(classified: ClassifiedError, context?: Record<string, unknown>): void {
  const level = classified.retriable ? 'warn' : 'error';
  const meta = {
    errorType: classified.type,
    action: classified.action,
    retriable: classified.retriable,
    status: classified.status,
    retryDelayMs: classified.retryDelayMs,
    ...context,
  };

  if (level === 'warn') {
    log.warn(meta, `LLM error [${classified.type}]: ${classified.message.slice(0, 200)}`);
  } else {
    log.error(meta, `LLM error [${classified.type}]: ${classified.message.slice(0, 200)}`);
  }
}
