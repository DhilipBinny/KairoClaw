/**
 * Re-export shim — delegates to @agw/agent-core.
 *
 * Wraps compaction functions to accept `db: DatabaseAdapter` and internally
 * construct the MessageStore interface that the extracted package expects.
 */

// ── Direct re-exports ────────────────────────────────────────
export type {
  CompactionCheck,
  CompactionResult,
  CallLLMFn,
  MessageWriter,
  MessageStore,
} from '@agw/agent-core';

export { estimateTokens, estimateMessageTokens } from '@agw/agent-core';
export type { MessageRow } from '@agw/agent-core';

// ── Wrapped re-exports ───────────────────────────────────────
import type { GatewayConfig } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import { MessageRepository } from '../db/repositories/message.js';
import {
  needsCompaction as _needsCompaction,
  compactSession as _compactSession,
  checkAndCompact as _checkAndCompact,
  setCompactionLogger,
  type CallLLMFn,
  type MessageStore,
  type CompactionCheck,
  type CompactionResult,
} from '@agw/agent-core';
import { createModuleLogger } from '../observability/logger.js';

// Wire the core logger into the agent-core compaction module
const log = createModuleLogger('llm');
setCompactionLogger(log as any);

/** Adapt a MessageRepository to the MessageStore interface. */
function repoToMessageStore(db: DatabaseAdapter): MessageStore {
  const repo = new MessageRepository(db);
  return {
    listBySession: (sessionId, limit) => repo.listBySession(sessionId, limit),
    listSinceId: (sessionId, sinceId) => repo.listSinceId(sessionId, sinceId),
    create: (msg) => repo.create(msg),
    deleteBySession: (sessionId) => repo.deleteBySession(sessionId),
    updateContent: (id, content) => repo.updateContent(id, content),
  };
}

/** Check whether a session's context is large enough to warrant compaction. */
export async function needsCompaction(
  sessionId: string,
  modelId: string,
  db: DatabaseAdapter,
  config: GatewayConfig,
): Promise<CompactionCheck> {
  return _needsCompaction(sessionId, modelId, repoToMessageStore(db), config);
}

/** Perform compaction on a session — summarizes older messages and keeps recent ones. */
export async function compactSession(
  sessionId: string,
  tenantId: string,
  modelId: string,
  db: DatabaseAdapter,
  config: GatewayConfig,
  callLLM?: CallLLMFn,
  scopeKey?: string | null,
): Promise<CompactionResult> {
  return _compactSession(sessionId, tenantId, modelId, repoToMessageStore(db), db, config, callLLM, scopeKey);
}

/**
 * Check and compact if needed. Called before agent turns.
 *
 * Two-stage compaction:
 * - Stage 1 (soft, 50% threshold): Strip old tool results in-place, no LLM call
 * - Stage 2 (hard, 75% threshold): Full LLM summarization with structured output
 */
export async function checkAndCompact(
  sessionId: string,
  modelId: string,
  db: DatabaseAdapter,
  config: GatewayConfig,
  callLLM?: CallLLMFn,
  tenantId?: string,
  scopeKey?: string | null,
): Promise<CompactionResult> {
  return _checkAndCompact(sessionId, modelId, repoToMessageStore(db), db, config, callLLM, tenantId, scopeKey);
}
