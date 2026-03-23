import type { DatabaseAdapter } from './index.js';
import fs from 'node:fs';
import path from 'node:path';

interface V1Session {
  sessionId: string;
  key: string;
  createdAt?: string;
  updatedAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
  lastChannel?: string | null;
  lastChatId?: string | null;
}

interface V1SessionStore {
  [key: string]: V1Session;
}

interface V1TranscriptEntry {
  role?: string;
  content?: string | object;
  ts?: string;
  channel?: string;
  sender?: string;
  tool_calls?: unknown;
  tool_call_id?: string;
}

interface V1McpServer {
  name?: string;
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  _fromCatalog?: string;
}

/** Map v1 channel strings to the v2 schema CHECK constraint values. */
function normalizeChannel(ch: string | null | undefined): string {
  if (!ch) return 'web';
  const lower = ch.toLowerCase();
  if (lower === 'telegram') return 'telegram';
  if (lower === 'slack') return 'slack';
  if (lower === 'api') return 'api';
  // cron, web, DM, unknown → default to 'api' (closest fit for programmatic access)
  if (lower === 'cron') return 'api';
  return 'web';
}

/** Map v1 transcript roles to the v2 schema CHECK constraint values. */
function normalizeRole(role: string | undefined): string {
  if (!role) return 'user';
  const lower = role.toLowerCase();
  if (lower === 'assistant') return 'assistant';
  if (lower === 'system') return 'system';
  if (lower === 'tool') return 'tool';
  return 'user';
}

/**
 * Migrate v1 data (JSON files) to the v2 SQLite database.
 * - Reads sessions/store.json → sessions table
 * - Reads *.jsonl transcript files → messages table
 * - Reads config.json MCP servers → mcp_servers table
 * - Renames migrated files with .migrated suffix
 *
 * Safe to call multiple times — checks for .migrated suffix.
 */
export async function migrateV1Data(
  db: DatabaseAdapter,
  stateDir: string,
  tenantId: string,
): Promise<{ sessions: number; messages: number; mcpServers: number }> {
  let sessionCount = 0;
  let messageCount = 0;
  let mcpCount = 0;

  // 1. Migrate sessions from store.json
  const storePath = path.join(stateDir, 'sessions', 'store.json');
  if (fs.existsSync(storePath) && !fs.existsSync(storePath + '.migrated')) {
    try {
      const store: V1SessionStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));

      await db.transaction(async () => {
        for (const [key, session] of Object.entries(store)) {
          const sessionId = session.sessionId || key;
          await db.run(
            `INSERT INTO sessions (id, tenant_id, channel, chat_id, model, input_tokens, output_tokens, turns, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
            [
              sessionId,
              tenantId,
              normalizeChannel(session.lastChannel),
              session.lastChatId || key,
              '',
              session.inputTokens || 0,
              session.outputTokens || 0,
              session.turns || 0,
              session.createdAt || new Date().toISOString(),
              session.updatedAt || new Date().toISOString(),
            ],
          );
          sessionCount++;
        }
      });

      fs.renameSync(storePath, storePath + '.migrated');
    } catch (e) {
      console.warn('v1 migration: failed to migrate store.json:', (e as Error).message);
    }
  }

  // 2. Migrate JSONL transcript files → messages
  const sessionsDir = path.join(stateDir, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    const jsonlFiles = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.migrated.jsonl'));

    for (const file of jsonlFiles) {
      const filePath = path.join(sessionsDir, file);
      try {
        const sessionId = path.basename(file, '.jsonl');

        // Ensure session row exists (transcript may reference a session not in store.json)
        const sessionExists = await db.get<{ id: string }>(
          'SELECT id FROM sessions WHERE id = ?',
          [sessionId],
        );
        if (!sessionExists) {
          await db.run(
            `INSERT INTO sessions (id, tenant_id, channel, chat_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
            [sessionId, tenantId, 'web', sessionId, new Date().toISOString(), new Date().toISOString()],
          );
        }

        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);

        await db.transaction(async () => {
          for (const line of lines) {
            try {
              const entry: V1TranscriptEntry = JSON.parse(line);
              const content =
                typeof entry.content === 'string'
                  ? entry.content
                  : JSON.stringify(entry.content || '');

              await db.run(
                `INSERT INTO messages (session_id, tenant_id, role, content, tool_calls, tool_call_id, metadata, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  sessionId,
                  tenantId,
                  normalizeRole(entry.role),
                  content,
                  entry.tool_calls ? JSON.stringify(entry.tool_calls) : null,
                  entry.tool_call_id || null,
                  entry.channel || entry.sender
                    ? JSON.stringify({ channel: entry.channel, sender: entry.sender })
                    : null,
                  entry.ts || new Date().toISOString(),
                ],
              );
              messageCount++;
            } catch {
              /* skip malformed lines */
            }
          }
        });

        fs.renameSync(filePath, filePath.replace('.jsonl', '.migrated.jsonl'));
      } catch (e) {
        console.warn(`v1 migration: failed to migrate ${file}:`, (e as Error).message);
      }
    }
  }

  // 3. Migrate MCP servers from config.json
  const configPath = path.join(stateDir, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const configRaw = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configRaw);
      const mcpServers: Record<string, V1McpServer> = config?.mcp?.servers || {};

      await db.transaction(async () => {
        for (const [id, server] of Object.entries(mcpServers)) {
          // Check if already migrated
          const exists = await db.get<{ id: string }>(
            'SELECT id FROM mcp_servers WHERE id = ?',
            [id],
          );
          if (exists) continue;

          await db.run(
            `INSERT INTO mcp_servers (id, tenant_id, name, transport, command, args, url, env, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              tenantId,
              server.name || id,
              server.transport || 'stdio',
              server.command || null,
              JSON.stringify(server.args || []),
              server.url || null,
              JSON.stringify(server.env || {}),
              server.enabled ? 1 : 0,
            ],
          );
          mcpCount++;
        }
      });
    } catch (e) {
      console.warn('v1 migration: failed to migrate MCP servers:', (e as Error).message);
    }
  }

  return { sessions: sessionCount, messages: messageCount, mcpServers: mcpCount };
}

/**
 * One-time reverse migration: move MCP servers from the SQLite DB
 * (`mcp_servers` table) into `config.json` under `mcp.servers`.
 *
 * Idempotent — skips if config.json already has MCP servers.
 * Returns the number of servers migrated.
 */
export async function migrateDbMcpToConfig(
  db: DatabaseAdapter,
  configPath: string,
): Promise<number> {
  // Read existing config
  let rawConfig: Record<string, any>;
  try {
    rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return 0;
  }

  // If config already has MCP servers, skip (already migrated)
  if (rawConfig.mcp?.servers && Object.keys(rawConfig.mcp.servers).length > 0) {
    return 0;
  }

  // Read MCP servers from DB
  let dbServers: Array<{
    id: string;
    transport: string;
    command: string | null;
    args: string | null;
    url: string | null;
    env: string | null;
    enabled: number;
    pinned_hash: string | null;
  }>;
  try {
    dbServers = await db.query<any>(
      'SELECT id, transport, command, args, url, env, enabled, pinned_hash FROM mcp_servers',
      [],
    );
  } catch {
    // Table might not exist
    return 0;
  }

  if (dbServers.length === 0) return 0;

  const servers: Record<string, any> = {};
  for (const row of dbServers) {
    const entry: Record<string, unknown> = {
      enabled: row.enabled === 1,
      transport: row.transport || 'stdio',
      command: row.command || undefined,
      args: row.args ? JSON.parse(row.args) : undefined,
      url: row.url || undefined,
      env: row.env ? JSON.parse(row.env) : undefined,
      pinnedHash: row.pinned_hash || undefined,
    };
    // Clean up undefined values
    for (const key of Object.keys(entry)) {
      if (entry[key] === undefined) delete entry[key];
    }
    servers[row.id] = entry;
  }

  rawConfig.mcp = { servers };
  fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), { mode: 0o600 });

  return dbServers.length;
}
