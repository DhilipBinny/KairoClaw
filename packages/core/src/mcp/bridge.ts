import fs from 'node:fs';
import type { Logger } from 'pino';
import type {
  GatewayConfig,
  MCPBridgeStatus,
  MCPServerConfig,
  MCPServerStatus,
  MCPTransportType,
  JSONSchemaProperty,
} from '@agw/types';
import { MCPClient } from './client.js';
import { detectToolSetChange } from './security.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SecretsStore } from '../secrets/store.js';

/** Namespaced tool definition exposed to the agent system. */
export interface NamespacedToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
  _mcpServer: string;
  _mcpToolName: string;
}

/**
 * MCP Bridge — manages multiple MCP server connections and exposes
 * their tools to the agent's tool system.
 *
 * Server configs are stored in config.json under `mcp.servers`.
 * Secrets stay in ~/.agw/mcp-secrets.json.
 * Runtime state (connection status) stays in memory on MCPClient objects.
 */
export class MCPBridge {
  private clients = new Map<string, MCPClient>();
  private _initializing = false;
  private config: GatewayConfig;
  private configPath: string;
  private log: Logger;
  private _toolRegistry: ToolRegistry | null = null;
  private _secretsStore: SecretsStore | null = null;
  private _reconnectAttempts = new Map<string, number>();
  private _reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static MAX_RECONNECT_ATTEMPTS = 10;
  private static MAX_RECONNECT_DELAY_MS = 60_000;

  constructor(config: GatewayConfig, configPath: string, log: Logger) {
    this.config = config;
    this.configPath = configPath;
    this.log = log;
  }

  /** Give the bridge a reference to the ToolRegistry for dynamic tool registration. */
  setToolRegistry(registry: ToolRegistry): void {
    this._toolRegistry = registry;
  }

  /** Give the bridge a secrets store for resolving sensitive env vars. */
  setSecretsStore(store: SecretsStore): void {
    this._secretsStore = store;
  }

  /** Get the secrets store (used by routes). */
  get secretsStore(): SecretsStore | null {
    return this._secretsStore;
  }

  /**
   * Persist MCP config to disk.
   *
   * Reads the raw config.json first and preserves `env` fields for existing
   * servers so that `${VAR}` templates are never lost. Structural changes
   * (add/remove servers, enabled, pinnedHash, command, args) come from the
   * runtime config.
   */
  private _persistConfig(): void {
    try {
      let rawConfig: Record<string, unknown>;
      try {
        rawConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      } catch {
        rawConfig = {};
      }

      const rawServers = ((rawConfig as any).mcp?.servers || {}) as Record<string, any>;
      const updatedServers: Record<string, unknown> = {};

      for (const [id, server] of Object.entries(this.config.mcp.servers)) {
        const rawServer = rawServers[id];
        const entry: Record<string, unknown> = {
          enabled: server.enabled,
          transport: server.transport,
          command: server.command,
          args: server.args,
          url: server.url,
          // Preserve env from raw file for existing servers (keeps ${VAR} templates)
          env: rawServer ? rawServer.env : server.env,
          headers: server.headers,
          pinnedHash: server.pinnedHash,
        };
        // Clean up undefined values
        for (const key of Object.keys(entry)) {
          if (entry[key] === undefined) delete entry[key];
        }
        updatedServers[id] = entry;
      }

      rawConfig.mcp = { servers: updatedServers };
      fs.writeFileSync(this.configPath, JSON.stringify(rawConfig, null, 2), { mode: 0o600 });
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'Failed to persist MCP config');
    }
  }

  /**
   * Initialize all enabled MCP servers from config.
   * Fires connections in the background — returns immediately.
   */
  async init(): Promise<void> {
    if (this._initializing) return;
    this._initializing = true;

    const enabledServers = Object.entries(this.config.mcp.servers)
      .filter(([, s]) => s.enabled);

    for (const [id, server] of enabledServers) {
      const placeholder = new MCPClient(id, server, this.log);
      placeholder._status = 'installing';
      placeholder._statusMessage = 'Starting process...';
      this.clients.set(id, placeholder);
      this._connectServerAsync(id, server, server.pinnedHash);
    }

    if (enabledServers.length > 0) {
      this.log.info({ count: enabledServers.length }, 'MCP bridge: connecting servers in background');
    }
    this._initializing = false;
  }

  /**
   * Fire-and-forget wrapper for _connectServer.
   * Catches errors and logs them.
   */
  private _connectServerAsync(
    id: string,
    serverConfig: MCPServerConfig,
    pinnedHash?: string | null,
  ): void {
    void (async () => {
      try {
        await this._connectServer(id, serverConfig, pinnedHash);
        this._syncToolsToRegistry(id);
      } catch (err) {
        const msg = (err as Error).message;
        this.log.error({ server: id, err: msg }, 'Background MCP connection failed');
      }
    })();
  }

  private async _connectServer(
    id: string,
    serverConfig: MCPServerConfig,
    pinnedHash?: string | null,
  ): Promise<MCPClient> {
    try {
      // Resolve env through secrets store (secrets file > process.env)
      const resolvedEnv = this._secretsStore
        ? this._secretsStore.resolveEnv(id, serverConfig.env || {})
        : serverConfig.env;

      // Resolve ${VAR} references in args (using secrets store + process.env)
      const secrets = this._secretsStore?.getServerSecrets(id) || {};
      const resolvedArgs = (serverConfig.args || []).map(arg =>
        typeof arg === 'string'
          ? arg.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, key: string) =>
              secrets[key] || process.env[key] || '')
          : arg,
      );

      const resolved: MCPServerConfig = { ...serverConfig, args: resolvedArgs, env: resolvedEnv };
      const client = new MCPClient(id, resolved, this.log);
      await client.connect();

      // Tool pinning: detect changes and update hash
      if (client.tools.length > 0) {
        const pinResult = detectToolSetChange(id, client.tools, pinnedHash ?? null);
        if (pinResult.changed) {
          this.log.warn(
            { server: id, diff: pinResult.diff },
            'MCP server tool set changed — updating pinned hash',
          );
        }
        // Persist pinned hash to config
        if (this.config.mcp.servers[id]) {
          this.config.mcp.servers[id].pinnedHash = pinResult.currentHash;
          this._persistConfig();
        }
      }

      // Wire auto-reconnect on unexpected transport close
      client.onTransportClose((_code) => {
        if (client._status === 'error') {
          this._unsyncToolsFromRegistry(id);
          this._autoReconnect(id, serverConfig, pinnedHash);
        }
      });

      // Clear reconnect state on successful connection
      this._cancelAutoReconnect(id);

      this.clients.set(id, client);
      return client;
    } catch (err) {
      this.log.error({ server: id, err: (err as Error).message }, 'Failed to connect MCP server');
      const failedClient = new MCPClient(id, serverConfig, this.log);
      failedClient._status = 'error';
      failedClient._error = (err as Error).message;
      this.clients.set(id, failedClient);
      throw err;
    }
  }

  /** Register an MCP server's tools with the ToolRegistry. */
  private _syncToolsToRegistry(id: string): void {
    if (!this._toolRegistry) return;
    const client = this.clients.get(id);
    if (!client || client._status !== 'connected') return;

    const bridge = this;
    for (const tool of client.tools) {
      const params = tool.inputSchema || { type: 'object', properties: {} };
      const namespacedName = `mcp__${id}__${tool.name}`;
      this._toolRegistry.register({
        definition: {
          name: namespacedName,
          description: `[${id}] ${tool.description}`,
          parameters: {
            type: 'object' as const,
            properties: (params.properties || {}) as Record<string, JSONSchemaProperty>,
            required: params.required || [],
          },
        },
        executor: async (args) => bridge.executeTool(namespacedName, args),
        source: 'mcp',
      });
    }
    this.log.info({ server: id, tools: client.tools.length }, 'Synced MCP tools to registry');
  }

  /** Remove an MCP server's tools from the ToolRegistry. */
  private _unsyncToolsFromRegistry(id: string): void {
    if (!this._toolRegistry) return;
    const prefix = `mcp__${id}__`;
    const defs = this._toolRegistry.getDefinitions();
    let removed = 0;
    for (const def of defs) {
      if (def.name.startsWith(prefix)) {
        this._toolRegistry.unregister(def.name);
        removed++;
      }
    }
    if (removed > 0) {
      this.log.info({ server: id, removed }, 'Unsynced MCP tools from registry');
    }
  }

  /** Auto-reconnect with exponential backoff. */
  private _autoReconnect(
    id: string,
    serverConfig: MCPServerConfig,
    pinnedHash?: string | null,
  ): void {
    // Guard: skip if a reconnect timer is already pending for this server
    if (this._reconnectTimers.has(id)) return;

    const attempts = this._reconnectAttempts.get(id) || 0;
    if (attempts >= MCPBridge.MAX_RECONNECT_ATTEMPTS) {
      this.log.warn({ server: id, attempts }, 'Max reconnect attempts reached — giving up');
      const existing = this.clients.get(id);
      if (existing) {
        existing._status = 'error';
        existing._statusMessage = `Failed after ${attempts} reconnect attempts. Use reconnect to retry.`;
      }
      return;
    }

    const delayMs = Math.min(1000 * Math.pow(2, attempts), MCPBridge.MAX_RECONNECT_DELAY_MS);
    this._reconnectAttempts.set(id, attempts + 1);

    this.log.info({ server: id, attempt: attempts + 1, delayMs }, 'Scheduling auto-reconnect');

    const timer = setTimeout(() => {
      this._reconnectTimers.delete(id);
      const existing = this.clients.get(id);
      if (existing) {
        existing._status = 'connecting';
        existing._statusMessage = `Reconnecting (attempt ${attempts + 1})...`;
      }
      this._connectServerAsync(id, serverConfig, pinnedHash);
    }, delayMs);

    this._reconnectTimers.set(id, timer);
  }

  /** Cancel any pending auto-reconnect for a server. */
  private _cancelAutoReconnect(id: string): void {
    const timer = this._reconnectTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this._reconnectTimers.delete(id);
    }
    this._reconnectAttempts.delete(id);
  }

  /**
   * Get all MCP tools merged into the agent's tool format.
   * Returns tools with namespaced names: "mcp__servername__toolname"
   */
  getToolDefinitions(): NamespacedToolDefinition[] {
    const tools: NamespacedToolDefinition[] = [];

    for (const [serverId, client] of this.clients) {
      if (client._status !== 'connected') continue;

      for (const tool of client.tools) {
        const params = tool.inputSchema || { type: 'object', properties: {} };

        tools.push({
          name: `mcp__${serverId}__${tool.name}`,
          description: `[${serverId}] ${tool.description}`,
          parameters: {
            type: params.type || 'object',
            properties: params.properties || {},
            required: params.required || [],
          },
          _mcpServer: serverId,
          _mcpToolName: tool.name,
        });
      }
    }

    return tools;
  }

  /**
   * Execute an MCP tool call.
   * @param namespacedName - "mcp__servername__toolname"
   * @param args - tool arguments
   */
  async executeTool(
    namespacedName: string,
    args?: Record<string, unknown>,
  ): Promise<string | { error: string } | Record<string, unknown>> {
    const parts = namespacedName.split('__');
    if (parts.length < 3 || parts[0] !== 'mcp') {
      return { error: `Invalid MCP tool name: ${namespacedName}` };
    }

    const serverId = parts[1];
    const toolName = parts.slice(2).join('__');

    const client = this.clients.get(serverId);
    if (!client) {
      return { error: `MCP server not found: ${serverId}` };
    }
    if (client._status !== 'connected') {
      return { error: `MCP server ${serverId} is ${client._status}: ${client._error || 'not connected'}` };
    }

    try {
      this.log.info({ server: serverId, tool: toolName, args: Object.keys(args || {}) }, 'MCP tool call');
      const result = await client.callTool(toolName, args);
      return result;
    } catch (err) {
      this.log.error({ server: serverId, tool: toolName, err: (err as Error).message }, 'MCP tool execution failed');
      return { error: `MCP tool error: ${(err as Error).message}` };
    }
  }

  /**
   * Check if a tool name belongs to an MCP server.
   */
  isMCPTool(toolName: string): boolean {
    return toolName.startsWith('mcp__');
  }

  /**
   * Get server config by ID (used by routes).
   */
  getServerConfig(id: string): MCPServerConfig | undefined {
    return this.config.mcp.servers[id];
  }

  /**
   * Enable and connect an MCP server (from catalog or custom config).
   * Saves to config.json and fires connection in background — returns immediately.
   */
  async enableServer(
    id: string,
    serverConfig: MCPServerConfig & { _fromCatalog?: string },
  ): Promise<MCPServerStatus | undefined> {
    const existing = this.config.mcp.servers[id];

    if (existing) {
      // Update existing
      Object.assign(this.config.mcp.servers[id], {
        enabled: true,
        command: serverConfig.command,
        args: serverConfig.args,
        url: serverConfig.url,
        env: serverConfig.env,
      });
    } else {
      // Create new
      this.config.mcp.servers[id] = {
        enabled: true,
        transport: serverConfig.transport || 'stdio',
        command: serverConfig.command,
        args: serverConfig.args,
        url: serverConfig.url,
        env: serverConfig.env,
        headers: serverConfig.headers,
      };
    }
    this._persistConfig();

    // Disconnect existing if any
    if (this.clients.has(id)) {
      this._unsyncToolsFromRegistry(id);
      await this.clients.get(id)!.disconnect();
      this.clients.delete(id);
    }

    // Create placeholder client with installing status, fire connection in background
    const config: MCPServerConfig = { ...serverConfig, enabled: true };
    const placeholder = new MCPClient(id, config, this.log);
    placeholder._status = 'installing';
    placeholder._statusMessage = 'Starting process...';
    this.clients.set(id, placeholder);

    this._connectServerAsync(id, config);

    return this.clients.get(id)?.status;
  }

  /**
   * Disable and disconnect an MCP server.
   */
  async disableServer(id: string): Promise<void> {
    this._cancelAutoReconnect(id);
    this._unsyncToolsFromRegistry(id);
    const client = this.clients.get(id);
    if (client) {
      await client.disconnect();
      this.clients.delete(id);
    }

    if (this.config.mcp.servers[id]) {
      this.config.mcp.servers[id].enabled = false;
      this._persistConfig();
    }
  }

  /**
   * Remove an MCP server entirely.
   */
  async removeServer(id: string): Promise<void> {
    this._cancelAutoReconnect(id);
    this._unsyncToolsFromRegistry(id);
    const client = this.clients.get(id);
    if (client) {
      await client.disconnect();
      this.clients.delete(id);
    }

    delete this.config.mcp.servers[id];
    this._persistConfig();
    this._secretsStore?.deleteServerSecrets(id);
  }

  /**
   * Reconnect a specific server (non-blocking).
   */
  async reconnectServer(id: string): Promise<MCPServerStatus | undefined> {
    const serverConfig = this.config.mcp.servers[id];
    if (!serverConfig) throw new Error(`Server ${id} not configured`);

    this._cancelAutoReconnect(id);
    this._unsyncToolsFromRegistry(id);

    if (this.clients.has(id)) {
      await this.clients.get(id)!.disconnect();
      this.clients.delete(id);
    }

    const placeholder = new MCPClient(id, serverConfig, this.log);
    placeholder._status = 'installing';
    placeholder._statusMessage = 'Starting process...';
    this.clients.set(id, placeholder);

    this._connectServerAsync(id, serverConfig, serverConfig.pinnedHash);
    return this.clients.get(id)?.status;
  }

  /**
   * Get status of all MCP servers.
   */
  getStatus(): MCPBridgeStatus {
    const servers: Record<string, MCPServerStatus> = {};

    for (const [id, server] of Object.entries(this.config.mcp.servers)) {
      const client = this.clients.get(id);
      const configEnvKeys = Object.keys(server.env || {});
      const secretKeys = this._secretsStore ? Object.keys(this._secretsStore.getServerSecrets(id)) : [];
      const envKeysSet = [...new Set([...configEnvKeys, ...secretKeys])];

      if (client) {
        servers[id] = {
          ...client.status,
          envKeys: envKeysSet,
          config: {
            transport: server.transport || 'stdio',
            command: server.command,
            url: server.url,
            enabled: server.enabled,
          },
        };
      } else {
        servers[id] = {
          name: id,
          status: server.enabled ? 'not_started' : 'disabled',
          error: null,
          statusMessage: null,
          toolCount: 0,
          tools: [],
          envKeys: envKeysSet,
          transport: server.transport || 'stdio',
          config: {
            transport: server.transport || 'stdio',
            command: server.command,
            url: server.url,
            enabled: server.enabled,
          },
        };
      }
    }

    return {
      totalServers: Object.keys(servers).length,
      connectedServers: [...this.clients.values()].filter(c => c._status === 'connected').length,
      totalTools: this.getToolDefinitions().length,
      servers,
    };
  }

  /**
   * Shutdown all MCP servers.
   */
  async shutdown(): Promise<void> {
    const ids = [...this._reconnectTimers.keys()];
    for (const id of ids) {
      this._cancelAutoReconnect(id);
    }
    const promises = [...this.clients.values()].map(c => c.disconnect().catch(() => {}));
    await Promise.allSettled(promises);
    this.clients.clear();
    this.log.info('MCP bridge shut down');
  }
}
