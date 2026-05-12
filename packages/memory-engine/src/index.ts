// ── Interfaces ────────────────────────────────────────────
export type {
  MessageRow,
  MessageLister,
  SessionUpdater,
  SessionRow,
} from './interfaces.js';

// ── Token estimation ──────────────────────────────────────
export { estimateTokens, estimateMessageTokens, setTokenEstimatorLogger } from './token-estimator.js';

// ── Memory system (chunk indexing + search) ───────────────
export { MemorySystem } from './memory-system.js';
export type { MemoryChunk, MemoryStats } from './memory-system.js';

// ── Session memory ────────────────────────────────────────
export {
  getSessionMemoryPath,
  readSessionMemory,
  getSessionMemoryForCompaction,
  loadSessionMemoryState,
  saveSessionMemoryState,
  createInitialState,
  shouldExtractSessionMemory,
  extractSessionMemory,
  cleanupSessionMemoryFiles,
  setSessionMemoryLogger,
  SESSION_MEMORY_TEMPLATE,
} from './session-memory.js';
export type { SessionMemoryState } from './session-memory.js';

// ── Auto-memory (profile extraction + consolidation) ──────
export {
  autoSummarizeToMemory,
  maybeExtractToProfile,
  consolidateMemory,
  setAutoMemoryLogger,
} from './auto-memory.js';

// ── Scope (per-user memory isolation) ─────────────────────
export {
  deriveScopeKey,
  deriveGroupScopeKey,
  resolveScopedFile,
  getScopedMemoryDir,
  ensureScopeDir,
  migrateScopesToUserUUID,
  migrateToSharedDir,
} from './scope.js';
