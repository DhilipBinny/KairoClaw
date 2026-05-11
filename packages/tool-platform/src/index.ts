export { ToolRegistry, type ToolRegistryDeps } from './registry.js';
export type { ToolRegistration, ToolExecutor } from './types.js';
export { textEnvelope, imageEnvelope, envelope } from './envelope.js';
export { LoopDetector, DEFAULT_WINDOW_SIZE, DEFAULT_TRIP_THRESHOLD } from './loop-detector.js';
export { ResultBudget, DEFAULT_RESULT_BUDGET_BYTES } from './result-budget.js';
export { ResultStorage, DEFAULT_PERSIST_THRESHOLD_BYTES, PREVIEW_CHARS, type ResultStorageOptions } from './result-storage.js';
export { ProgressBus, type ProgressEvent, type ProgressSubscriber } from './progress-bus.js';
export { checkToolPermission, type PermissionChecker } from './permissions.js';
export type { AuditLogger, ToolCallRecorder } from './interfaces.js';
export {
  matchesHookPattern,
  runPreToolUseHooks,
  runPostToolUseHooks,
  runSessionStartHooks,
  runPostCompactHooks,
  setHooksLogger,
  type HookConfig,
  type HooksConfig,
  type SessionLifecycleHook,
  type PreToolHookResult,
} from './hooks-runner.js';
