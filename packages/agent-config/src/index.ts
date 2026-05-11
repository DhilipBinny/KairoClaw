/**
 * @agw/agent-config — programmatic agent identity, rulesets, and configuration.
 *
 * Replaces file-based IDENTITY.md / RULES.md / SOUL.md with structured,
 * database-backed agent definitions for the enterprise agentic studio.
 */

// Types
export type {
  AgentPersona,
  AgentRule,
  MemoryPolicy,
  AgentDefinition,
  AgentDefinitionStore,
} from './types.js';

// Prompt builder
export { buildPromptFromDefinition } from './prompt-builder.js';

// Rule enforcement
export { enforceRules, resolveAgentTools } from './rules.js';
export type { RuleCheckResult } from './rules.js';
