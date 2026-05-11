/**
 * Agent configuration types — programmatic identity, rulesets, and policies.
 *
 * Replaces the file-based IDENTITY.md / RULES.md / SOUL.md approach
 * with structured, database-backed agent definitions.
 */

/** Agent persona — identity, tone, and behavioral constraints. */
export interface AgentPersona {
  identity: string;
  tone?: string;
  traits?: string[];
  restrictions?: string[];
}

/** Agent rule — a single behavioral or safety constraint. */
export interface AgentRule {
  id: string;
  type: 'safety' | 'behavioral' | 'operational';
  description: string;
  enforcement: 'block' | 'warn' | 'log';
}

/** Memory policy for an agent. */
export interface MemoryPolicy {
  enabled: boolean;
  scope: 'per-user' | 'shared' | 'none';
  maxProfileChars?: number;
  sessionMemoryEnabled?: boolean;
  autoExtractToProfile?: boolean;
}

/** Full agent definition — everything needed to configure and run an agent. */
export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  persona: AgentPersona;
  rules: AgentRule[];
  model: string;
  fallbackModel?: string;
  tools: string[];
  memory: MemoryPolicy;
  maxToolRounds?: number;
  thinkingEnabled?: boolean;
}

/** Persistence interface for agent definitions. */
export interface AgentDefinitionStore {
  get(id: string): Promise<AgentDefinition | undefined>;
  list(): Promise<AgentDefinition[]>;
  create(def: AgentDefinition): Promise<void>;
  update(id: string, fields: Partial<AgentDefinition>): Promise<void>;
  delete(id: string): Promise<void>;
}
