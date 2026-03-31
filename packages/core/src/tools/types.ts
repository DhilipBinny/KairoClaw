import type { ToolDefinition, ToolResult, ToolExecutionContext } from '@agw/types';
export type { ToolDefinition, ToolResult, ToolExecutionContext };

export type ToolExecutor = (
  args: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<ToolResult>;

export interface ToolRegistration {
  definition: ToolDefinition;
  executor: ToolExecutor;
  source: 'builtin' | 'mcp' | 'cli_plugin' | 'http_plugin';
  category?: 'read' | 'write' | 'execute' | 'destructive';
  /**
   * Whether this tool is safe to run concurrently with other concurrent-safe
   * tools in the same round. Read-only tools (file_read, web_fetch, etc.)
   * are safe; tools with side effects (file_write, shell_exec) are not.
   *
   * Defaults to false (sequential) when omitted — fail-safe.
   */
  concurrencySafe?: boolean;
}
