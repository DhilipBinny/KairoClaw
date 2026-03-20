import type { DatabaseAdapter } from '../index.js';

export interface MCPServerRow {
  id: string;
  tenant_id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string | null; // JSON array
  url: string | null;
  env: string | null; // JSON object
  enabled: number; // SQLite boolean (0/1)
  pinned_hash: string | null;
  status_message: string | null;
  installed_at: string;
  updated_at: string;
}

/** Parsed MCP server with args/env deserialized. */
export interface MCPServerParsed {
  id: string;
  tenant_id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  enabled: boolean;
  pinned_hash: string | null;
  status_message: string | null;
  installed_at: string;
  updated_at: string;
}

function parseRow(row: MCPServerRow): MCPServerParsed {
  return {
    ...row,
    args: row.args ? JSON.parse(row.args) : [],
    env: row.env ? JSON.parse(row.env) : {},
    enabled: row.enabled === 1,
  };
}

export class MCPServerRepository {
  constructor(private db: DatabaseAdapter) {}

  create(server: {
    id: string;
    tenantId: string;
    name: string;
    transport: string;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  }): MCPServerRow {
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO mcp_servers (id, tenant_id, name, transport, command, args, url, env, enabled, pinned_hash, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      [
        server.id,
        server.tenantId,
        server.name,
        server.transport,
        server.command ?? null,
        server.args ? JSON.stringify(server.args) : null,
        server.url ?? null,
        server.env ? JSON.stringify(server.env) : null,
        now,
        now,
      ],
    );

    return this.db.get<MCPServerRow>('SELECT * FROM mcp_servers WHERE id = ?', [server.id])!;
  }

  getById(id: string): MCPServerRow | undefined {
    return this.db.get<MCPServerRow>('SELECT * FROM mcp_servers WHERE id = ?', [id]);
  }

  listByTenant(tenantId: string): MCPServerRow[] {
    return this.db.query<MCPServerRow>(
      'SELECT * FROM mcp_servers WHERE tenant_id = ? ORDER BY name ASC',
      [tenantId],
    );
  }

  listEnabled(tenantId: string): MCPServerRow[] {
    return this.db.query<MCPServerRow>(
      'SELECT * FROM mcp_servers WHERE tenant_id = ? AND enabled = 1 ORDER BY name ASC',
      [tenantId],
    );
  }

  update(
    id: string,
    data: Partial<{
      name: string;
      enabled: boolean;
      pinned_hash: string;
      status_message: string | null;
      command: string;
      args: string[];
      url: string;
      env: Record<string, string>;
    }>,
  ): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) {
      fields.push('name = ?');
      values.push(data.name);
    }
    if (data.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(data.enabled ? 1 : 0);
    }
    if (data.pinned_hash !== undefined) {
      fields.push('pinned_hash = ?');
      values.push(data.pinned_hash);
    }
    if (data.status_message !== undefined) {
      fields.push('status_message = ?');
      values.push(data.status_message);
    }
    if (data.command !== undefined) {
      fields.push('command = ?');
      values.push(data.command);
    }
    if (data.args !== undefined) {
      fields.push('args = ?');
      values.push(JSON.stringify(data.args));
    }
    if (data.url !== undefined) {
      fields.push('url = ?');
      values.push(data.url);
    }
    if (data.env !== undefined) {
      fields.push('env = ?');
      values.push(JSON.stringify(data.env));
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.run(`UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM mcp_servers WHERE id = ?', [id]);
  }
}

export { parseRow as parseMCPServerRow };
