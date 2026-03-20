import type { ToolDefinition, ToolResult, ToolExecutionContext } from '@agw/types';
export type { ToolDefinition, ToolResult, ToolExecutionContext };

export type ToolExecutor = (
  args: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<ToolResult>;

export interface ToolRegistration {
  definition: ToolDefinition;
  executor: ToolExecutor;
  source: 'builtin' | 'mcp';
  category?: 'read' | 'write' | 'execute' | 'destructive';
}
