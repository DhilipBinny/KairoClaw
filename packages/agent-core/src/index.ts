// ── Compaction ────────────────────────────────────────────
export {
  estimateTokens,
  estimateMessageTokens,
  needsCompaction,
  compactSession,
  checkAndCompact,
  setCompactionLogger,
} from './compaction.js';
export type {
  MessageRow,
  MessageWriter,
  MessageStore,
  CompactionCheck,
  CompactionResult,
  CallLLMFn,
} from './compaction.js';

// ── System Prompt ────────────────────────────────────────
export { buildSystemPrompt } from './prompt.js';

// ── Router ───────────────────────────────────────────────
export {
  classifyByRules,
  classifyByLLM,
  stripModelOverride,
  routeModel,
  setRouterLogger,
} from './router.js';
export type { RoutingTier, RoutingResult } from './router.js';

// ── Slash Commands ───────────────────────────────────────
export { handleSlashCommand } from './slash-commands.js';
export type {
  SessionLister,
  SlashCommandContext,
  SlashCommandResult,
} from './slash-commands.js';

// ── Agent Loop Types ────────────────────────────────────────
export type {
  AgentSessionRow,
  AgentContext,
  AgentRoundCallbacks,
} from './loop-types.js';

// ── Message Utilities ───────────────────────────────────────
export {
  buildUserContent,
  normalizeMessages,
  renderToolResultForLLM,
  sanitizeMessagesForLog,
  rowToMessage,
} from './messages.js';

// ── Tool Execution ──────────────────────────────────────────
export {
  executeSingleTool,
  executeToolCalls,
} from './tool-execution.js';
export type {
  ToolCallRecorder,
  ParsedToolCall,
  ToolExecContext,
} from './tool-execution.js';
