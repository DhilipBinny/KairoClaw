/**
 * MCP Registry (marketplace) search.
 * Proxies to the official MCP registry at registry.modelcontextprotocol.io
 */

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
