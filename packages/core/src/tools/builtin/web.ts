import dns from 'node:dns';
import type { ToolRegistration } from '../types.js';
import { textEnvelope } from '../envelope.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  const lines: string[] = [
    `Query: ${query}`,
    `${results.length} result${results.length === 1 ? '' : 's'}:`,
    '',
  ];
  for (const [i, r] of results.entries()) {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    lines.push(`   ${r.snippet}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Validate a URL for web_fetch to prevent SSRF attacks.
 * Blocks private IPs, loopback, link-local, and cloud metadata endpoints.
 */
/** Check if an IP address (v4 or v6) is private/reserved. */
function isPrivateIP(ip: string): boolean {
  // IPv4
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
    return false;
  }

  // IPv6 — normalize and check known private ranges
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true;  // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;  // unique local
  // IPv4-mapped IPv6 (::ffff:A.B.C.D)
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIP(v4Mapped[1]);

  return false;
}

/**
 * Normalize an allowPrivate entry ("localhost:3000", "127.0.0.1",
 * "dev.internal") to a lowercase `host[:port]` form. Used by
 * isAllowedPrivate() to match the parsed URL's host.
 */
function normalizeAllowEntry(entry: string): string {
  return entry.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Phase 12: check whether a parsed URL matches any of the user's
 * `tools.webFetch.allowPrivate` entries. Each entry can be a bare
 * host or `host:port`. If matched, the URL bypasses the SSRF guard
 * (so e.g. `localhost:3000` can be fetched when explicitly allowed).
 */
function isAllowedPrivate(parsed: URL, allowPrivate: string[] | undefined): boolean {
  if (!allowPrivate || allowPrivate.length === 0) return false;
  const host = parsed.hostname.toLowerCase();
  const hostPort = parsed.port ? `${host}:${parsed.port}` : host;
  for (const raw of allowPrivate) {
    const entry = normalizeAllowEntry(raw);
    if (entry === host || entry === hostPort) return true;
  }
  return false;
}

export function validateFetchUrl(urlStr: string, allowPrivate?: string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked URL scheme: ${parsed.protocol} — only http/https allowed`);
  }

  // Phase 12: explicit allowPrivate override lets specific dev hosts
  // through the SSRF guard. Applied BEFORE the block checks so
  // allowPrivate: ["localhost:3000"] actually works.
  if (isAllowedPrivate(parsed, allowPrivate)) {
    return parsed;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block loopback addresses
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) {
    throw new Error('Blocked: localhost/loopback URLs not allowed');
  }

  // Block private/reserved IPs (v4 and v6)
  if (isPrivateIP(hostname)) {
    throw new Error('Blocked: private/reserved IP address');
  }

  // Block cloud metadata endpoints
  const blockedHosts = ['metadata.google.internal', 'metadata.google.com', 'instance-data'];
  if (blockedHosts.some(h => hostname === h || hostname.endsWith('.' + h))) {
    throw new Error('Blocked: cloud metadata endpoint');
  }

  return parsed;
}

/**
 * Resolve DNS and validate the resolved IP is not private.
 * Prevents DNS rebinding attacks (e.g., evil.com → 169.254.169.254).
 */
export async function validateResolvedIP(hostname: string): Promise<void> {
  // Skip if hostname is already an IP literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) return;

  try {
    const { address } = await dns.promises.lookup(hostname);
    if (isPrivateIP(address)) {
      throw new Error(`Blocked: hostname "${hostname}" resolves to private IP ${address}`);
    }
  } catch (e: unknown) {
    // Re-throw our own blocked errors
    if (e instanceof Error && e.message.startsWith('Blocked:')) throw e;
    // DNS resolution failure — let fetch handle it naturally
  }
}

export const webTools: ToolRegistration[] = [
  {
    definition: {
      name: 'web_fetch',
      description: 'Fetch a URL and extract readable content as markdown/text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          maxChars: { type: 'number', description: 'Maximum characters to return' },
        },
        required: ['url'],
      },
    },
    executor: async (args, context) => {
      const url = args.url as string;
      if (!url || typeof url !== 'string') {
        return { error: 'url is required' };
      }

      const ctxCfg = (context as Record<string, unknown>).config as
        | { tools?: { webFetch?: { allowPrivate?: string[] } } }
        | undefined;
      const allowPrivate = ctxCfg?.tools?.webFetch?.allowPrivate;

      try {
        const parsed = validateFetchUrl(url, allowPrivate);
        // Skip DNS-resolved private check when the host is allowlisted
        if (!allowPrivate || !allowPrivate.some((e) => {
          const n = e.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
          return n === parsed.hostname.toLowerCase() || n === `${parsed.hostname.toLowerCase()}:${parsed.port}`;
        })) {
          await validateResolvedIP(parsed.hostname);
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { error: `SSRF protection: ${message}` };
      }

      const ctx = context as Record<string, unknown>;
      const configMaxChars = (ctx.config as Record<string, Record<string, Record<string, unknown>>>)?.tools?.webFetch?.maxChars as number | undefined;
      const defaultMaxChars = typeof configMaxChars === 'number' && configMaxChars > 0 ? configMaxChars : 50000;
      const maxChars = (args.maxChars as number) || defaultMaxChars;

      try {
        // Use manual redirect handling to validate each hop against SSRF
        let currentUrl = url;
        let res: Response;
        const maxRedirects = 5;
        for (let i = 0; ; i++) {
          res = await fetch(currentUrl, {
            headers: { 'User-Agent': 'AgenticGateway/2.0' },
            signal: AbortSignal.timeout(30000),
            redirect: 'manual',
          });
          if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            if (i >= maxRedirects) return { error: 'Too many redirects' };
            const nextUrl = new URL(res.headers.get('location')!, currentUrl);
            const next = nextUrl.href;
            try {
              validateFetchUrl(next);
              await validateResolvedIP(nextUrl.hostname);
            } catch (e: unknown) {
              return { error: `SSRF protection on redirect: ${e instanceof Error ? e.message : String(e)}` };
            }
            currentUrl = next;
            continue;
          }
          break;
        }

        // Stream response to avoid OOM on huge pages
        const reader = res.body?.getReader();
        let text = '';
        if (reader) {
          const decoder = new TextDecoder();
          const byteLimit = maxChars * 4; // generous byte limit
          let bytesRead = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytesRead += value.byteLength;
            text += decoder.decode(value, { stream: true });
            if (bytesRead >= byteLimit) break;
          }
          reader.cancel().catch(() => {});
        } else {
          text = await res.text();
        }

        // Strip scripts, styles, and HTML tags for readable content
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, maxChars);

        // Hint: if content is mostly empty, the site likely needs JS rendering
        const hint = text.length < 200
          ? '\nHint: Content appears very short — this site may require JavaScript rendering. Try the browse tool instead.'
          : '';
        return textEnvelope(`URL: ${url}\nChars: ${text.length}${hint}\n\n${text}`);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { error: `Fetch failed: ${message}` };
      }
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
    isReadOnly: true,
    // Web pages can be large — 96 KB threshold before persistence kicks in.
    // Lower than exec (build logs) but higher than files.ts (64 KB).
    maxResultSizeChars: 96 * 1024,
    getActivityDescription: (input) => {
      const u = (input as { url?: string })?.url ?? '<url>';
      return `Fetching ${u}`;
    },
  },
  {
    definition: {
      name: 'web_search',
      description: 'Search the web using Brave Search API. Returns titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          count: { type: 'number', description: 'Number of results (1-10, default 5)' },
        },
        required: ['query'],
      },
    },
    executor: async (args, context) => {
      // API key comes from context (injected from config)
      const ctx = context as Record<string, unknown>;
      const apiKey = ctx.braveApiKey as string | undefined;
      if (!apiKey) return { error: 'Brave Search API key not configured' };

      const query = args.query as string;
      if (!query) return { error: 'query is required' };

      const count = Math.min((args.count as number) || 5, 10);

      try {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
        const res = await fetch(url, {
          headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        });

        if (!res.ok) {
          return { error: `Brave Search API returned ${res.status}: ${res.statusText}` };
        }

        const data = await res.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
        const results = (data.web?.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description,
        }));

        return textEnvelope(formatSearchResults(query, results));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { error: `Search failed: ${message}` };
      }
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
    isReadOnly: true,
    getActivityDescription: (input) => {
      const q = (input as { query?: string })?.query ?? '';
      return `Searching: ${q.slice(0, 60)}`;
    },
  },
];
