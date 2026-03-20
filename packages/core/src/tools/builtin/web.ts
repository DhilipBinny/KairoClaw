import type { ToolRegistration } from '../types.js';

/**
 * Validate a URL for web_fetch to prevent SSRF attacks.
 * Blocks private IPs, loopback, link-local, and cloud metadata endpoints.
 */
function validateFetchUrl(urlStr: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked URL scheme: ${parsed.protocol} — only http/https allowed`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block loopback addresses
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) {
    throw new Error('Blocked: localhost/loopback URLs not allowed');
  }

  // Block private and reserved IP ranges
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const [, aStr, bStr] = ipMatch;
    const a = Number(aStr);
    const b = Number(bStr);
    if (a === 10) throw new Error('Blocked: private IP range (10.x.x.x)');
    if (a === 172 && b >= 16 && b <= 31) throw new Error('Blocked: private IP range (172.16-31.x.x)');
    if (a === 192 && b === 168) throw new Error('Blocked: private IP range (192.168.x.x)');
    if (a === 169 && b === 254) throw new Error('Blocked: link-local/cloud metadata (169.254.x.x)');
    if (a === 0) throw new Error('Blocked: invalid IP range (0.x.x.x)');
  }

  // Block cloud metadata endpoints
  const blockedHosts = ['metadata.google.internal', 'metadata.google.com', 'instance-data'];
  if (blockedHosts.some(h => hostname === h || hostname.endsWith('.' + h))) {
    throw new Error('Blocked: cloud metadata endpoint');
  }

  return parsed;
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
    executor: async (args) => {
      const url = args.url as string;
      if (!url || typeof url !== 'string') {
        return { error: 'url is required' };
      }

      try {
        validateFetchUrl(url);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { error: `SSRF protection: ${message}` };
      }

      const maxChars = (args.maxChars as number) || 50000;

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'AgenticGateway/2.0' },
          signal: AbortSignal.timeout(30000),
          redirect: 'follow',
        });

        let text = await res.text();

        // Strip scripts, styles, and HTML tags for readable content
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, maxChars);

        return { content: text, url, chars: text.length };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { error: `Fetch failed: ${message}` };
      }
    },
    source: 'builtin',
    category: 'read',
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
        });

        const data = await res.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
        const results = (data.web?.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description,
        }));

        return { results, query };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { error: `Search failed: ${message}` };
      }
    },
    source: 'builtin',
    category: 'read',
  },
];
