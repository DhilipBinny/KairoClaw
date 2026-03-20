import type { MCPCatalogEntry } from '@agw/types';

// ══════════════════════════════════════════════
// Curated MCP Server Catalog
// ══════════════════════════════════════════════

// Curated picks — lightweight, practical for a personal AI gateway
export const MCP_CATALOG: Record<string, MCPCatalogEntry> = {
  github: {
    name: 'GitHub',
    description: 'Issues, PRs, repos, code search, file contents',
    package: '@modelcontextprotocol/server-github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    envVars: [
      { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub Personal Access Token', required: true, sensitive: true, placeholder: 'ghp_...' },
    ],
    category: 'development',
    icon: '🐙',
  },
slack: {
    name: 'Slack',
    description: 'Read channels, send messages, search Slack workspace',
    package: '@modelcontextprotocol/server-slack',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}', SLACK_TEAM_ID: '${SLACK_TEAM_ID}' },
    envKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    envVars: [
      { key: 'SLACK_BOT_TOKEN', label: 'Slack Bot Token', required: true, sensitive: true, placeholder: 'xoxb-...' },
      { key: 'SLACK_TEAM_ID', label: 'Slack Team ID', required: true, sensitive: false, placeholder: 'T01234567' },
    ],
    category: 'communication',
    icon: '💬',
  },
};

// ══════════════════════════════════════════════
// MCP Registry (marketplace) search
// ══════════════════════════════════════════════

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

/**
 * Search the official MCP registry.
 * Proxies to https://registry.modelcontextprotocol.io/v0/servers
 */
export async function searchMCPRegistry(
  query: string,
  limit = 20,
  cursor?: string,
): Promise<MCPRegistryResult> {
  const clampedLimit = Math.min(limit, 50);
  const params = new URLSearchParams({ limit: String(clampedLimit) });
  if (query) params.set('search', query);
  if (cursor) params.set('cursor', cursor);

  const url = `https://registry.modelcontextprotocol.io/v0/servers?${params}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Registry returned ${response.status}`);
    }

    const data = (await response.json()) as {
      servers?: Array<{
        server?: {
          name?: string;
          description?: string;
          version?: string;
          packages?: Array<{ registryType?: string; identifier?: string; runtimeHint?: string }>;
          remotes?: Array<{ url?: string; type?: string }>;
          repository?: { url?: string };
        };
        name?: string;
        description?: string;
        version?: string;
        packages?: Array<{ registryType?: string; identifier?: string; runtimeHint?: string }>;
        remotes?: Array<{ url?: string; type?: string }>;
        repository?: { url?: string };
      }>;
      metadata?: { nextCursor?: string; total?: number };
    };

    // Map registry format (nested server object) to our flat format
    const servers: MCPRegistryServer[] = (data.servers || []).map(entry => {
      const s = entry.server || entry;
      const npmPkg = (s.packages || []).find(p => p.registryType === 'npm');
      const remote = (s.remotes || [])[0];
      const repoUrl = s.repository?.url || '';
      return {
        id: s.name || '',
        name: s.name || '',
        description: s.description || '',
        version: s.version || '',
        package: npmPkg?.identifier || '',
        runtimeHint: npmPkg?.runtimeHint || 'npx',
        remoteUrl: remote?.url || '',
        remoteType: remote?.type || '',
        repoUrl,
        installable: !!(npmPkg?.identifier || remote?.url),
        transport: npmPkg ? 'stdio' : remote ? 'sse' : '',
      };
    });

    return {
      servers,
      nextCursor: data.metadata?.nextCursor || null,
      total: data.metadata?.total || servers.length,
    };
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === 'AbortError') {
      throw new Error('Registry request timed out');
    }
    throw err;
  }
}
