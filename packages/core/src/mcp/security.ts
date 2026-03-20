import crypto from 'node:crypto';
import type { MCPToolDefinition } from '@agw/types';

/**
 * Compute a hash of tool definitions for change detection (tool pinning).
 */
export function computeToolHash(tools: MCPToolDefinition[]): string {
  const normalized = tools
    .map(t => `${t.name}:${t.description}:${JSON.stringify(t.inputSchema)}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Detect if a server's tool set has changed since last connection.
 * Returns diff details if changed.
 */
export function detectToolSetChange(
  serverId: string,
  currentTools: MCPToolDefinition[],
  pinnedHash: string | null,
): { changed: boolean; currentHash: string; diff?: string } {
  const currentHash = computeToolHash(currentTools);
  if (!pinnedHash) return { changed: false, currentHash }; // First connection, no pin yet

  const changed = currentHash !== pinnedHash;
  return {
    changed,
    currentHash,
    diff: changed
      ? `Tool set changed for ${serverId}. Previous hash: ${pinnedHash}, Current: ${currentHash}`
      : undefined,
  };
}

/**
 * Validate MCP server environment variables don't contain gateway secrets.
 */
export function validateServerEnv(env: Record<string, string>): { safe: boolean; warnings: string[] } {
  const sensitivePatterns = [
    /^agw_sk_/i,          // Our API keys
    /anthropic.*key/i,     // Anthropic API keys
    /openai.*key/i,        // OpenAI API keys
    /telegram.*token/i,    // Telegram bot tokens
  ];

  const warnings: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    for (const pattern of sensitivePatterns) {
      if (pattern.test(value)) {
        warnings.push(`Environment variable ${key} may contain a sensitive value`);
      }
    }
  }

  return { safe: warnings.length === 0, warnings };
}
