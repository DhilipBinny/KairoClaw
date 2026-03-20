/**
 * Tool system types.
 *
 * Tools are functions the agent can invoke during a conversation turn.
 * Each tool has a JSON Schema definition, an executor, and optional
 * permission controls.
 */

import type { Session } from './session.js';

/**
 * JSON Schema object describing a tool's parameters.
 *
 * Uses a subset of JSON Schema sufficient for LLM tool-calling.
 */
export interface JSONSchemaObject {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
}

/** A single property within a JSON Schema object. */
export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JSONSchemaProperty>;
  items?: JSONSchemaProperty;
}

/**
 * A tool definition exposed to the LLM.
 *
 * The `parameters` field is a JSON Schema object that the LLM uses
 * to generate valid arguments.
 */
export interface ToolDefinition {
  /** Unique tool name (e.g. `read_file`, `exec`, `mcp__github__list_issues`). */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  parameters: JSONSchemaObject;
  /** MCP server ID if this tool comes from an MCP server. */
  _mcpServer?: string;
  /** Original MCP tool name (without namespace prefix). */
  _mcpToolName?: string;
}

/**
 * The result returned by a tool executor.
 *
 * Can be a plain string or a structured object — the agent loop
 * serialises objects to JSON before passing them back to the LLM.
 */
export type ToolResult = string | Record<string, unknown>;

/**
 * Context passed to tool executors.
 *
 * Provides access to the current session and other runtime state
 * the tool may need.
 */
export interface ToolExecutionContext {
  /** The active session for this conversation. */
  session?: Session;
  /** Database handle (reserved for future use). */
  db?: unknown;
  /** User identity information. */
  user?: {
    id?: string;
    name?: string;
  };
  /** Tenant identifier (reserved for multi-tenant mode). */
  tenant?: string;
}

/** Permission level for a tool. */
export type ToolPermissionLevel = 'allow' | 'deny' | 'confirm';

/**
 * A permission rule controlling tool access.
 *
 * Tool patterns support glob matching (e.g. `mcp__*`, `exec`).
 */
export interface ToolPermission {
  /** Glob pattern matching tool names. */
  toolPattern: string;
  /** Role this permission applies to. */
  role: string;
  /** The permission level. */
  permission: ToolPermissionLevel;
}
