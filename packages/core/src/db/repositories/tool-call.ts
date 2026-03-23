import type { DatabaseAdapter } from '../index.js';

export interface ToolCallRow {
  id: string;
  session_id: string;
  tenant_id: string;
  user_id: string | null;
  tool_name: string;
  arguments: string; // JSON
  result: string | null; // JSON
  status: string;
  duration_ms: number | null;
  approved_by: string | null;
  created_at: string;
}

export class ToolCallRepository {
  constructor(private db: DatabaseAdapter) {}

  async record(call: {
    id: string;
    sessionId: string;
    tenantId: string;
    userId?: string;
    toolName: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    status: string;
    durationMs?: number;
  }): Promise<void> {
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO tool_calls (id, session_id, tenant_id, user_id, tool_name, arguments, result, status, duration_ms, approved_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [
        call.id,
        call.sessionId,
        call.tenantId,
        call.userId ?? null,
        call.toolName,
        JSON.stringify(call.arguments),
        call.result !== undefined ? JSON.stringify(call.result) : null,
        call.status,
        call.durationMs ?? null,
        now,
      ],
    );
  }

  async listBySession(sessionId: string, limit = 100): Promise<ToolCallRow[]> {
    return await this.db.query<ToolCallRow>(
      'SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
      [sessionId, limit],
    );
  }

  async listByTool(tenantId: string, toolName: string, limit = 100): Promise<ToolCallRow[]> {
    return await this.db.query<ToolCallRow>(
      'SELECT * FROM tool_calls WHERE tenant_id = ? AND tool_name = ? ORDER BY created_at DESC LIMIT ?',
      [tenantId, toolName, limit],
    );
  }

  async updateStatus(id: string, status: string, result?: unknown, durationMs?: number): Promise<void> {
    const fields: string[] = ['status = ?'];
    const values: unknown[] = [status];

    if (result !== undefined) {
      fields.push('result = ?');
      values.push(JSON.stringify(result));
    }
    if (durationMs !== undefined) {
      fields.push('duration_ms = ?');
      values.push(durationMs);
    }

    values.push(id);

    await this.db.run(`UPDATE tool_calls SET ${fields.join(', ')} WHERE id = ?`, values);
  }
}
