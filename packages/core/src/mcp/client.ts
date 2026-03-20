import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type {
  MCPServerConfig,
  MCPServerStatus,
  MCPServerStatusValue,
  MCPToolDefinition,
  MCPTransportType,
} from '@agw/types';

// ══════════════════════════════════════════════
// JSON-RPC types
// ══════════════════════════════════════════════

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface MCPToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// ══════════════════════════════════════════════
// JSON-RPC helpers
// ══════════════════════════════════════════════

function jsonrpcRequest(method: string, params: Record<string, unknown> | undefined, id: string): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id } satisfies JsonRpcRequest);
}

function parseJsonrpcResponse(data: string): JsonRpcResponse | null {
  try {
    return JSON.parse(data) as JsonRpcResponse;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════
// Stdio Transport
// ══════════════════════════════════════════════

class StdioTransport {
  private command: string;
  private args: string[];
  private env: Record<string, string>;
  private process: ReturnType<typeof spawn> | null = null;
  private buffer = '';
  private pendingRequests = new Map<string, PendingRequest>();
  private notificationHandlers = new Map<string, (params: Record<string, unknown> | undefined) => void>();
  private log: Logger;
  _onClose: ((code: number | null) => void) | null = null;

  constructor(command: string, args: string[], env: Record<string, string>, log: Logger) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.log = log;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const mergedEnv = { ...process.env, ...this.env };
      // Strip ALL sensitive env vars from child process (matching exec tool)
      const SENSITIVE_ENV_KEYS = [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'OPENAI_API_KEY',
        'TELEGRAM_BOT_TOKEN',
        'AGW_TOKEN',
        'BRAVE_API_KEY',
        'AGW_ADMIN_KEY',
      ];
      for (const key of SENSITIVE_ENV_KEYS) {
        delete mergedEnv[key];
      }

      const child = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: mergedEnv,
      });
      this.process = child;

      let started = false;
      const startTimeout = setTimeout(() => {
        if (!started) {
          started = true;
          // Process started but no greeting — that's fine for MCP
          resolve();
        }
      }, 5000);

      child.stdout!.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString();
        this._processBuffer();
        if (!started) {
          started = true;
          clearTimeout(startTimeout);
          resolve();
        }
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) this.log.debug({ transport: 'stdio', stderr: text.slice(0, 500) }, 'MCP server stderr');
      });

      // ChildProcessWithoutNullStreams may lack .on() in some @types/node versions
      (child as unknown as NodeJS.EventEmitter).on('error', (err: Error) => {
        if (!started) {
          started = true;
          clearTimeout(startTimeout);
          reject(err);
        }
        this._rejectAll(err);
      });

      (child as unknown as NodeJS.EventEmitter).on('close', (code: number | null) => {
        this.log.info({ code }, 'MCP stdio process exited');
        this._rejectAll(new Error(`Process exited with code ${code}`));
        if (this._onClose) this._onClose(code);
      });
    });
  }

  private _processBuffer(): void {
    // MCP uses newline-delimited JSON
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;

      const msg = parseJsonrpcResponse(line);
      if (!msg) continue;

      // Response to a request
      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const pending = this.pendingRequests.get(msg.id)!;
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      // Notification (no id)
      else if (msg.method) {
        const handler = this.notificationHandlers.get(msg.method);
        if (handler) handler(msg.params);
      }
    }
  }

  async send(method: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    if (!this.process || this.process.killed) {
      throw new Error('Transport not connected');
    }

    const id = randomUUID();
    const message = jsonrpcRequest(method, params, id);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timed out: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      this.process!.stdin!.write(message + '\n');
    });
  }

  onNotification(method: string, handler: (params: Record<string, unknown> | undefined) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  private _rejectAll(err: Error): void {
    for (const [, { reject }] of this.pendingRequests) {
      reject(err);
    }
    this.pendingRequests.clear();
  }

  async close(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      // Force kill after 5s
      const proc = this.process;
      setTimeout(() => {
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 5000);
    }
  }

  get connected(): boolean {
    return !!(this.process && !this.process.killed);
  }
}

// ══════════════════════════════════════════════
// SSE Transport
// ══════════════════════════════════════════════

class SSETransport {
  private url: string;
  private headers: Record<string, string>;
  private sessionUrl: string | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private notificationHandlers = new Map<string, (params: Record<string, unknown> | undefined) => void>();
  private _abortController: AbortController | null = null;
  private _connected = false;
  private log: Logger;

  constructor(url: string, headers: Record<string, string>, log: Logger) {
    this.url = url;
    this.headers = headers;
    this.log = log;
  }

  async connect(): Promise<void> {
    this._abortController = new AbortController();

    const response = await fetch(this.url, {
      headers: { ...this.headers, Accept: 'text/event-stream' },
      signal: this._abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: HTTP ${response.status}`);
    }

    this._connected = true;

    // Read the SSE stream in the background
    this._readStream(response.body!).catch(() => {});

    // Wait briefly for the endpoint message
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify the stream is still alive after the wait
    if (!this._connected) {
      throw new Error('SSE stream disconnected during initial connection');
    }
  }

  private async _readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = 'message';
        let eventData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            eventData += line.slice(6);
          } else if (line === '') {
            // End of event
            if (eventType === 'endpoint' && eventData) {
              const baseUrl = new URL(this.url);
              this.sessionUrl = new URL(eventData.trim(), baseUrl).toString();
            } else if (eventType === 'message' && eventData) {
              const msg = parseJsonrpcResponse(eventData);
              if (msg) this._handleMessage(msg);
            }
            eventType = 'message';
            eventData = '';
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        this.log.error({ err: (err as Error).message }, 'SSE stream error');
      }
    } finally {
      this._connected = false;
    }
  }

  private _handleMessage(msg: JsonRpcResponse): void {
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
    } else if (msg.method) {
      const handler = this.notificationHandlers.get(msg.method);
      if (handler) handler(msg.params);
    }
  }

  async send(method: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    const postUrl = this.sessionUrl || this.url;

    const id = randomUUID();
    const body = jsonrpcRequest(method, params, id);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timed out: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      fetch(postUrl, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body,
      }).catch(err => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err as Error);
      });
    });
  }

  onNotification(method: string, handler: (params: Record<string, unknown> | undefined) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  async close(): Promise<void> {
    if (this._abortController) {
      this._abortController.abort();
    }
    this._connected = false;
  }

  get connected(): boolean {
    return this._connected;
  }
}

// ══════════════════════════════════════════════
// Transport interface (union type)
// ══════════════════════════════════════════════

type Transport = StdioTransport | SSETransport;

// ══════════════════════════════════════════════
// MCP Client
// ══════════════════════════════════════════════

export class MCPClient {
  readonly name: string;
  readonly config: MCPServerConfig;
  private transport: Transport | null = null;
  tools: MCPToolDefinition[] = [];
  serverInfo: Record<string, unknown> | null = null;
  _status: MCPServerStatusValue = 'disconnected';
  _error: string | null = null;
  _statusMessage: string | null = null;
  _connectedAt: number | null = null;
  private _onTransportCloseHandler: ((code: number | null) => void) | null = null;
  private log: Logger;

  constructor(name: string, serverConfig: MCPServerConfig, log: Logger) {
    this.name = name;
    this.config = serverConfig;
    this.log = log;
  }

  async connect(): Promise<void> {
    try {
      this._status = 'connecting';
      this._error = null;
      this._statusMessage = 'Starting process...';

      // Create transport
      if (this.config.transport === 'sse') {
        this.transport = new SSETransport(
          this.config.url!,
          this.config.headers || {},
          this.log,
        );
      } else {
        // Default: stdio
        // Env is already resolved by the bridge (via secrets store + process.env)
        this.transport = new StdioTransport(
          this.config.command!,
          this.config.args || [],
          (this.config.env || {}) as Record<string, string>,
          this.log,
        );
      }

      await this.transport.connect();
      this._statusMessage = 'Handshaking...';

      // MCP Initialize handshake
      const initResult = await this.transport.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        clientInfo: {
          name: 'agentic-gateway',
          version: '0.2.0',
        },
      }) as { serverInfo?: Record<string, unknown> } | null;

      this.serverInfo = initResult?.serverInfo || {};
      this.log.info({ server: this.name, info: this.serverInfo }, 'MCP server initialized');

      // Send initialized notification (stdio only — write directly to stdin)
      if (this.transport instanceof StdioTransport && this.transport.connected) {
        void this.transport.send('notifications/initialized', {}, 5000).catch(err => {
          this.log.warn({ err: (err as Error).message, serverId: this.name }, 'Failed to send initialized notification');
        });
      }

      // Discover tools
      this._statusMessage = 'Discovering tools...';
      await this.refreshTools();

      // Wire up transport close handler for auto-reconnect
      if (this.transport instanceof StdioTransport) {
        this.transport._onClose = (code) => {
          if (this._status === 'connected') {
            this._status = 'error';
            this._error = `Process exited unexpectedly (code ${code})`;
            this._statusMessage = null;
            this.log.warn({ server: this.name, code }, 'MCP server process exited unexpectedly');
          }
          if (this._onTransportCloseHandler) {
            this._onTransportCloseHandler(code);
          }
        };
      }

      this._status = 'connected';
      this._connectedAt = Date.now();
      this._statusMessage = `Connected with ${this.tools.length} tool${this.tools.length !== 1 ? 's' : ''}`;
      this.log.info({ server: this.name, tools: this.tools.length }, 'MCP server connected');
    } catch (err) {
      this._status = 'error';
      this._error = (err as Error).message;
      this._statusMessage = null;
      this.log.error({ server: this.name, err: (err as Error).message }, 'MCP server connection failed');
      throw err;
    }
  }

  /** Register a handler called when the underlying transport process exits. */
  onTransportClose(handler: (code: number | null) => void): void {
    this._onTransportCloseHandler = handler;
  }

  async refreshTools(): Promise<MCPToolDefinition[]> {
    const result = await this.transport!.send('tools/list', {}) as { tools?: Array<{ name: string; description?: string; inputSchema?: { type: string; properties: Record<string, unknown>; required?: string[] } }> } | null;
    this.tools = (result?.tools || []).map(tool => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      _mcpServer: this.name,
    }));
    return this.tools;
  }

  async callTool(toolName: string, args?: Record<string, unknown>): Promise<string | { error: string } | { content: MCPToolCallResult['content']; text: string }> {
    const result = await this.transport!.send('tools/call', {
      name: toolName,
      arguments: args || {},
    }, 120000) as MCPToolCallResult | null; // 2 min timeout for tool calls

    // MCP returns { content: [{ type: "text", text: "..." }, ...], isError?: boolean }
    if (result?.isError) {
      const errorText = (result.content || [])
        .filter(c => c.type === 'text')
        .map(c => c.text || '')
        .join('\n');
      return { error: errorText || 'MCP tool returned an error' };
    }

    // Extract text content
    const textParts = (result?.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text || '');

    return textParts.length === 1
      ? textParts[0]
      : { content: result?.content || [], text: textParts.join('\n') };
  }

  async disconnect(): Promise<void> {
    this._status = 'disconnected';
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.tools = [];
  }

  get status(): MCPServerStatus {
    return {
      name: this.name,
      status: this._status,
      error: this._error,
      statusMessage: this._statusMessage,
      serverInfo: this.serverInfo || undefined,
      toolCount: this.tools.length,
      tools: this.tools.map(t => t.name),
      connectedAt: this._connectedAt,
      transport: (this.config.transport || 'stdio') as MCPTransportType,
    };
  }
}
