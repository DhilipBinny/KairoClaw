import crypto from 'node:crypto';
import dns from 'node:dns';
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
 * Detect MCP server environment variables that look like they carry gateway or
 * provider secrets — these would be handed to a third-party MCP process.
 *
 * Matches on BOTH the variable name (e.g. ANTHROPIC_API_KEY, *_TOKEN, *SECRET*)
 * and the value's shape (gateway/provider key prefixes, bot-token format), since
 * a real key value rarely contains the word "anthropic"/"openai".
 */
// Names that point at a SPECIFIC gateway/provider credential — strong enough on
// their own to warn (an MCP server has no reason to receive these).
const SPECIFIC_KEY_PATTERNS = [
  /anthropic.*key/i,
  /openai.*key/i,
  /telegram.*token/i,
];

// Generic credential-ish names. A server legitimately needs its OWN secrets
// (GITHUB_TOKEN, WEATHER_API_KEY, …), so these only warn when the value also
// looks like a real secret — avoiding warning fatigue that masks real leaks.
const GENERIC_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password|passwd/i,
  /(^|_)token$/i,
  /auth[_-]?token/i,
];

// Value shapes of known gateway/provider secrets — warn wherever they appear.
const SENSITIVE_VALUE_PATTERNS = [
  /^agw_sk_/i,                 // gateway API key
  /^sk-ant-/i,                 // Anthropic
  /^sk-proj-/i,                // OpenAI project key
  /^sk-[A-Za-z0-9]{20,}/,      // OpenAI / generic "sk-" key
  /^AIza[0-9A-Za-z_-]{30,}/,   // Google API key
  /^\d{6,}:[A-Za-z0-9_-]{30,}$/, // Telegram bot token
];

/** Heuristic: a long, mixed-character, whitespace-free string looks like a credential. */
function looksLikeSecret(value: string): boolean {
  return value.length >= 20 && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && !/\s/.test(value);
}

export function validateServerEnv(env: Record<string, string>): { safe: boolean; warnings: string[] } {
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    const v = typeof value === 'string' ? value : '';
    const flagged =
      SPECIFIC_KEY_PATTERNS.some(p => p.test(key)) ||
      SENSITIVE_VALUE_PATTERNS.some(p => p.test(v)) ||
      (GENERIC_KEY_PATTERNS.some(p => p.test(key)) && looksLikeSecret(v));
    if (flagged) {
      warnings.push(`Environment variable ${key} may expose a gateway/provider secret to the MCP server`);
    }
  }
  return { safe: warnings.length === 0, warnings };
}

// ── MCP URL SSRF validation ──────────────────────────────

function isPrivateIP(ip: string): boolean {
  const v4Match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4Match) {
    const [, aStr, bStr] = v4Match;
    const a = Number(aStr);
    const b = Number(bStr);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64.0.0/10)
    return false;
  }
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIP(v4Mapped[1]);
  return false;
}

/**
 * Validate a URL for MCP streamable-http transport.
 * Blocks private IPs, loopback, link-local, and cloud metadata endpoints.
 * An optional allowlist lets admins explicitly permit specific local servers.
 */
export function validateMcpUrl(urlStr: string, allowPrivate?: string[]): URL {
  let parsed: URL;
  try { parsed = new URL(urlStr); } catch { throw new Error('Invalid URL'); }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked URL scheme: ${parsed.protocol} — only http/https allowed`);
  }

  if (allowPrivate && allowPrivate.length > 0) {
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const hostPort = parsed.port ? `${host}:${parsed.port}` : host;
    for (const raw of allowPrivate) {
      const entry = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^\[|\]$/g, '');
      if (entry === host || entry === hostPort) return parsed;
    }
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) {
    throw new Error('Blocked: localhost/loopback URLs not allowed (add to mcp.allowPrivate to override)');
  }
  if (isPrivateIP(hostname)) {
    throw new Error('Blocked: private/reserved IP address');
  }
  const blockedHosts = ['metadata.google.internal', 'metadata.google.com', 'instance-data'];
  if (blockedHosts.some(h => hostname === h || hostname.endsWith('.' + h))) {
    throw new Error('Blocked: cloud metadata endpoint');
  }
  return parsed;
}

/**
 * DNS rebinding protection — resolve hostname and verify the IP isn't private.
 */
export async function validateResolvedMcpIP(hostname: string): Promise<void> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) return;
  try {
    const results = await dns.promises.lookup(hostname, { all: true });
    for (const { address } of results) {
      if (isPrivateIP(address)) {
        throw new Error(`Blocked: hostname "${hostname}" resolves to private IP ${address}`);
      }
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.message.startsWith('Blocked:')) throw e;
  }
}
