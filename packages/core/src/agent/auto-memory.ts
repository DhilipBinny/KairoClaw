/**
 * Re-export shim — delegates to @agw/memory-engine.
 *
 * Wraps autoSummarizeToMemory(), maybeExtractToProfile(), and
 * consolidateMemory() to accept the core DatabaseAdapter and
 * internally construct the MessageLister interface.
 */

// ── Direct re-exports ─────────────────────────────────────
export { consolidateMemory } from '@agw/memory-engine';

// ── Wrapped re-exports ────────────────────────────────────
import type { GatewayConfig, ChatArgs, ProviderResponse } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import { MessageRepository } from '../db/repositories/message.js';
import {
  autoSummarizeToMemory as _autoSummarizeToMemory,
  maybeExtractToProfile as _maybeExtractToProfile,
  setAutoMemoryLogger,
} from '@agw/memory-engine';
import type { MessageLister } from '@agw/memory-engine';
import { createModuleLogger } from '../observability/logger.js';

// Wire the core logger into the memory-engine auto-memory module
const log = createModuleLogger('memory');
setAutoMemoryLogger(log as any);

/** Adapt a MessageRepository to the MessageLister interface. */
function repoToMessageLister(db: DatabaseAdapter): MessageLister {
  const repo = new MessageRepository(db);
  return {
    listBySession: (sessionId, limit) => repo.listBySession(sessionId, limit),
    listSinceId: (sessionId, sinceId) => repo.listSinceId(sessionId, sinceId),
  };
}

/**
 * Extract NEW facts from a session and save to layered memory.
 * Backward-compatible wrapper that accepts `db: DatabaseAdapter`.
 *
 * @deprecated Use `maybeExtractToProfile` instead.
 */
export async function autoSummarizeToMemory(opts: {
  sessionId: string;
  channel: string;
  scopeKey?: string | null;
  db: DatabaseAdapter;
  config: GatewayConfig;
  callLLM: (args: ChatArgs) => Promise<ProviderResponse>;
  minTurns?: number;
}): Promise<void> {
  return _autoSummarizeToMemory({
    sessionId: opts.sessionId,
    channel: opts.channel,
    scopeKey: opts.scopeKey,
    messageLister: repoToMessageLister(opts.db),
    config: opts.config,
    callLLM: opts.callLLM,
    minTurns: opts.minTurns,
  });
}

/**
 * Extract long-term facts from session memory to profile.
 * Backward-compatible wrapper that accepts `db: DatabaseAdapter`.
 */
export async function maybeExtractToProfile(opts: {
  sessionId: string;
  channel: string;
  scopeKey?: string | null;
  db: DatabaseAdapter;
  config: GatewayConfig;
  callLLM: (args: ChatArgs) => Promise<ProviderResponse>;
  minTurns?: number;
}): Promise<void> {
  return _maybeExtractToProfile({
    sessionId: opts.sessionId,
    channel: opts.channel,
    scopeKey: opts.scopeKey,
    messageLister: repoToMessageLister(opts.db),
    config: opts.config,
    callLLM: opts.callLLM,
    minTurns: opts.minTurns,
  });
}
