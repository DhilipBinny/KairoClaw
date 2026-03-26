/**
 * Shared utilities for builtin tools.
 */

export function getWorkspace(context: Record<string, unknown>): string {
  return (context.workspace as string) ||
    ((context.config as Record<string, Record<string, string>>)?.agent?.workspace) ||
    process.cwd();
}
