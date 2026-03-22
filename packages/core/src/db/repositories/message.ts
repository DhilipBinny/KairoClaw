import type { DatabaseAdapter } from '../index.js';

export interface MessageRow {
  id: number;
  session_id: string;
  tenant_id: string;
  role: string;
  content: string;
  tool_calls: string | null; // JSON
  tool_call_id: string | null;
  metadata: string | null; // JSON
  created_at: string;
}

export class MessageRepository {
  constructor(private db: DatabaseAdapter) {}

  create(msg: {
    sessionId: string;
    tenantId: string;
    role: string;
    content: string;
    toolCalls?: string;
    toolCallId?: string;
    metadata?: string;
  }): MessageRow {
    const now = new Date().toISOString();

    const result = this.db.run(
      `INSERT INTO messages (session_id, tenant_id, role, content, tool_calls, tool_call_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.sessionId,
        msg.tenantId,
        msg.role,
        msg.content,
        msg.toolCalls ?? null,
        msg.toolCallId ?? null,
        msg.metadata ?? null,
        now,
      ],
    );

    return this.db.get<MessageRow>('SELECT * FROM messages WHERE id = ?', [result.lastInsertRowid])!;
  }

  listBySession(sessionId: string, limit?: number, offset?: number): MessageRow[] {
    let sql = 'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC';
    const params: unknown[] = [sessionId];

    if (limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    if (offset !== undefined) {
      if (limit === undefined) {
        sql += ' LIMIT -1';
      }
      sql += ' OFFSET ?';
      params.push(offset);
    }

    return this.db.query<MessageRow>(sql, params);
  }

  countBySession(sessionId: string): number {
    const row = this.db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM messages WHERE session_id = ?',
      [sessionId],
    );
    return row?.count ?? 0;
  }

  getLatest(sessionId: string, count: number): MessageRow[] {
    const rows = this.db.query<MessageRow>(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
      [sessionId, count],
    );
    return rows.reverse();
  }

  deleteBySession(sessionId: string): void {
    this.db.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
  }
}
