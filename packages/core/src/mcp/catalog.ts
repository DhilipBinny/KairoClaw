/**
 * MCP Server Catalog + Registry Search
 *
 * Local catalog: curated list of popular MCP servers with pre-configured
 * commands and env var specs. No network needed for browsing.
 *
 * Registry search: optional live search against the official MCP registry.
 * Cached for 5 minutes, retries once on timeout, graceful fallback.
 */

// ── Types ────────────────────────────────────────────────

export interface EnvVarSpec {
  key: string;
  label: string;
  required: boolean;
  sensitive: boolean;
  placeholder?: string;
  helpUrl?: string;
}

export interface CatalogEntry {
  name: string;
  description: string;
  package: string;
  transport: 'stdio' | 'sse';
  command: string;
  args: string[];
  envVars: EnvVarSpec[];
  category: string;
}

export interface MCPRegistryServer {
  id: string;
  name: string;
  description: string;
  version: string;
  package: string;
  runtimeHint: string;
  remoteUrl: string;
  remoteType: string;
  repoUrl: string;
  installable: boolean;
  transport: string;
}

export interface MCPRegistryResult {
  servers: MCPRegistryServer[];
  nextCursor: string | null;
  total: number;
}

// ── Local Catalog ────────────────────────────────────────

export const MCP_CATALOG: Record<string, CatalogEntry> = {
  // --- Development ---
  github: {
    name: 'GitHub',
    description: 'Issues, PRs, repos, code search, file contents',
    package: '@modelcontextprotocol/server-github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envVars: [
      { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub Personal Access Token', required: true, sensitive: true, placeholder: 'ghp_...', helpUrl: 'https://github.com/settings/tokens' },
    ],
    category: 'development',
  },
  gitlab: {
    name: 'GitLab',
    description: 'Issues, merge requests, repos, pipelines',
    package: '@modelcontextprotocol/server-gitlab',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gitlab'],
    envVars: [
      { key: 'GITLAB_PERSONAL_ACCESS_TOKEN', label: 'GitLab Personal Access Token', required: true, sensitive: true, placeholder: 'glpat-...' },
      { key: 'GITLAB_API_URL', label: 'GitLab API URL', required: false, sensitive: false, placeholder: 'https://gitlab.com/api/v4' },
    ],
    category: 'development',
  },
  // --- Communication ---
  slack: {
    name: 'Slack',
    description: 'Read channels, send messages, search workspace',
    package: '@modelcontextprotocol/server-slack',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envVars: [
      { key: 'SLACK_BOT_TOKEN', label: 'Slack Bot Token', required: true, sensitive: true, placeholder: 'your-slack-bot-token' },
      { key: 'SLACK_TEAM_ID', label: 'Slack Team ID', required: true, sensitive: false, placeholder: 'T01234567' },
    ],
    category: 'communication',
  },

  // --- Search ---
  'brave-search': {
    name: 'Brave Search',
    description: 'Web search with privacy focus',
    package: '@modelcontextprotocol/server-brave-search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envVars: [
      { key: 'BRAVE_API_KEY', label: 'Brave Search API Key', required: true, sensitive: true, placeholder: 'BSA...', helpUrl: 'https://brave.com/search/api/' },
    ],
    category: 'search',
  },

  // --- Data ---
  postgres: {
    name: 'PostgreSQL',
    description: 'Query and manage PostgreSQL databases',
    package: '@modelcontextprotocol/server-postgres',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    envVars: [
      { key: 'POSTGRES_CONNECTION_STRING', label: 'Connection String', required: true, sensitive: true, placeholder: 'postgres://user:pass@host:5432/db' },
    ],
    category: 'data',
  },
  sqlite: {
    name: 'SQLite',
    description: 'Query and manage SQLite databases',
    package: '@modelcontextprotocol/server-sqlite',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite'],
    envVars: [
      { key: 'SQLITE_DB_PATH', label: 'Database Path', required: true, sensitive: false, placeholder: '/path/to/database.db' },
    ],
    category: 'data',
  },

  // --- Cloud ---
  'aws-kb-retrieval': {
    name: 'AWS Knowledge Base',
    description: 'Retrieve from AWS Bedrock Knowledge Bases using RAG',
    package: '@modelcontextprotocol/server-aws-kb-retrieval',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-aws-kb-retrieval'],
    envVars: [
      { key: 'AWS_ACCESS_KEY_ID', label: 'AWS Access Key', required: true, sensitive: true },
      { key: 'AWS_SECRET_ACCESS_KEY', label: 'AWS Secret Key', required: true, sensitive: true },
      { key: 'AWS_REGION', label: 'AWS Region', required: true, sensitive: false, placeholder: 'us-east-1' },
    ],
    category: 'cloud',
  },

  // --- Productivity ---
  'google-maps': {
    name: 'Google Maps',
    description: 'Location services, directions, and place details',
    package: '@modelcontextprotocol/server-google-maps',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    envVars: [
      { key: 'GOOGLE_MAPS_API_KEY', label: 'Google Maps API Key', required: true, sensitive: true },
    ],
    category: 'productivity',
  },
};

// ── Registry Search (with cache + retry) ─────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { data: MCPRegistryResult; ts: number }>();

function getCached(key: string): MCPRegistryResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: MCPRegistryResult): void {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 50) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

async function fetchWithRetry(url: string, retries = 1): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timeout);
      return response;
    } catch (err) {
      clearTimeout(timeout);
      if (attempt < retries) continue;
      throw err;
    }
  }
  throw new Error('Registry request failed');
}

/** Search the official MCP registry. Cached 5min, retries once. */
export async function searchMCPRegistry(
  query: string,
  limit = 20,
  cursor?: string,
): Promise<MCPRegistryResult> {
  const clampedLimit = Math.min(limit, 50);
  const cacheKey = `${query}:${clampedLimit}:${cursor || ''}`;

  const cached = getCached(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({ limit: String(clampedLimit) });
  if (query) params.set('search', query);
  if (cursor) params.set('cursor', cursor);

  const url = `https://registry.modelcontextprotocol.io/v0/servers?${params}`;

  try {
    const response = await fetchWithRetry(url, 1);
    if (!response.ok) throw new Error(`Registry returned ${response.status}`);

    const data = (await response.json()) as {
      servers?: Array<{
        server?: {
          name?: string; description?: string; version?: string;
          packages?: Array<{ registryType?: string; identifier?: string; runtimeHint?: string }>;
          remotes?: Array<{ url?: string; type?: string }>;
          repository?: { url?: string };
        };
        name?: string; description?: string; version?: string;
        packages?: Array<{ registryType?: string; identifier?: string; runtimeHint?: string }>;
        remotes?: Array<{ url?: string; type?: string }>;
        repository?: { url?: string };
      }>;
      metadata?: { nextCursor?: string; total?: number };
    };

    const servers: MCPRegistryServer[] = (data.servers || []).map(entry => {
      const s = entry.server || entry;
      const npmPkg = (s.packages || []).find(p => p.registryType === 'npm');
      const remote = (s.remotes || [])[0];
      return {
        id: s.name || '',
        name: s.name || '',
        description: s.description || '',
        version: s.version || '',
        package: npmPkg?.identifier || '',
        runtimeHint: npmPkg?.runtimeHint || 'npx',
        remoteUrl: remote?.url || '',
        remoteType: remote?.type || '',
        repoUrl: s.repository?.url || '',
        installable: !!(npmPkg?.identifier || remote?.url),
        transport: npmPkg ? 'stdio' : remote ? 'sse' : '',
      };
    });

    const result: MCPRegistryResult = {
      servers,
      nextCursor: data.metadata?.nextCursor || null,
      total: data.metadata?.total || servers.length,
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    const stale = cache.get(cacheKey);
    if (stale) return stale.data;
    if ((err as Error).name === 'AbortError') throw new Error('Registry request timed out');
    throw err;
  }
}
