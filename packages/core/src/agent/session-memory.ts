/**
 * Re-export shim — delegates to @agw/memory-engine.
 *
 * Wraps extractSessionMemory() and saveSessionMemoryState() to accept
 * the core DatabaseAdapter / SessionRepository and internally construct
 * the MessageLister / SessionUpdater interfaces that the extracted
 * package expects.
 */

// ── Direct re-exports (no adaptation needed) ─────────────
export type { SessionMemoryState } from '@agw/memory-engine';
export {
  SESSION_MEMORY_TEMPLATE,
  getSessionMemoryPath,
  readSessionMemory,
  getSessionMemoryForCompaction,
  loadSessionMemoryState,
  createInitialState,
  shouldExtractSessionMemory,
  cleanupSessionMemoryFiles,
} from '@agw/memory-engine';

// ── Wrapped re-exports ───────────────────────────────────
import type { GatewayConfig, ChatArgs, ProviderResponse } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import { MessageRepository } from '../db/repositories/message.js';
import { SessionRepository } from '../db/repositories/session.js';
import {
  extractSessionMemory as _extractSessionMemory,
  saveSessionMemoryState as _saveSessionMemoryState,
  setSessionMemoryLogger,
} from '@agw/memory-engine';
import type { SessionMemoryState, MessageLister, SessionUpdater } from '@agw/memory-engine';
import { createModuleLogger } from '../observability/logger.js';

// Wire the core logger into the memory-engine session-memory module
const log = createModuleLogger('memory');
setSessionMemoryLogger(log as any);

/** Adapt a MessageRepository to the MessageLister interface. */
function repoToMessageLister(db: DatabaseAdapter): MessageLister {
  const repo = new MessageRepository(db);
  return {
    listBySession: (sessionId, limit) => repo.listBySession(sessionId, limit),
    listSinceId: (sessionId, sinceId) => repo.listSinceId(sessionId, sinceId),
  };
}

/** Adapt a SessionRepository to the SessionUpdater interface. */
function repoToSessionUpdater(repo: SessionRepository): SessionUpdater {
  return {
    getById: (id) => repo.getById(id),
    update: (id, data) => repo.update(id, data),
  };
}

/**
 * Extract/update session memory from recent messages.
 * Backward-compatible wrapper that accepts `db: DatabaseAdapter`.
 */
export async function extractSessionMemory(opts: {
  sessionId: string;
  scopeKey: string | null;
  db: DatabaseAdapter;
  config: GatewayConfig;
  state: SessionMemoryState;
  currentTokens: number;
  callLLM: (args: ChatArgs) => Promise<ProviderResponse>;
}): Promise<SessionMemoryState> {
  return _extractSessionMemory({
    sessionId: opts.sessionId,
    scopeKey: opts.scopeKey,
    messageLister: repoToMessageLister(opts.db),
    config: opts.config,
    state: opts.state,
    currentTokens: opts.currentTokens,
    callLLM: opts.callLLM,
  });
}

/**
 * Save session memory state to session metadata.
 * Backward-compatible wrapper that accepts a concrete SessionRepository.
 */
export async function saveSessionMemoryState(
  sessionId: string,
  state: SessionMemoryState,
  sessionRepo: SessionRepository,
): Promise<void> {
  return _saveSessionMemoryState(sessionId, state, repoToSessionUpdater(sessionRepo));
}
