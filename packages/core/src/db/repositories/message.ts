import type { DatabaseAdapter } from '../index.js';

export interface MessageRow {
  id: number;
  session_id: string;
  tenant_id: string;
  role: string;
  content: string;
  tool_calls: string | null; // JSON
  tool_call_id: string | null;
  thinking_blocks: string | null; // JSON
  metadata: string | null; // JSON
  created_at: string;
}

export class MessageRepository {
  constructor(private db: DatabaseAdapter) {}

  async create(msg: {
    sessionId: string;
    tenantId: string;
    role: string;
    content: string;
    toolCalls?: string;
    toolCallId?: string;
    thinkingBlocks?: string;
    metadata?: string;
  }): Promise<MessageRow> {
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO messages (session_id, tenant_id, role, content, tool_calls, tool_call_id, thinking_blocks, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.sessionId,
        msg.tenantId,
        msg.role,
        msg.content,
        msg.toolCalls ?? null,
        msg.toolCallId ?? null,
        msg.thinkingBlocks ?? null,
        msg.metadata ?? null,
        now,
      ],
    );

    return (await this.db.get<MessageRow>(
      'SELECT * FROM messages WHERE session_id = ? AND role = ? AND created_at = ? ORDER BY id DESC LIMIT 1',
      [msg.sessionId, msg.role, now],
    ))!;
  }

  async listBySession(sessionId: string, limit?: number, offset?: number): Promise<MessageRow[]> {
    // Tiebreak on id so messages inserted within the same millisecond (e.g. a
    // parallel tool-result batch, or an assistant turn and its tool results)
    // keep insertion order — otherwise a tool result could sort before its
    // assistant tool_use and orphan the pair on reload.
    let sql = 'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC';
    const params: unknown[] = [sessionId];

    if (limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    if (offset !== undefined) {
      if (limit === undefined) {
        sql += ' LIMIT 2147483647'; // max int, compatible with both SQLite and PostgreSQL
      }
      sql += ' OFFSET ?';
      params.push(offset);
    }

    return await this.db.query<MessageRow>(sql, params);
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.db.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
  }

  /** Update the content of a single message by id. */
  async updateContent(id: number, content: string): Promise<void> {
    await this.db.run('UPDATE messages SET content = ? WHERE id = ?', [content, id]);
  }

  /** List messages in a session after a given message ID (for incremental processing). */
  async listSinceId(sessionId: string, sinceId: number): Promise<MessageRow[]> {
    return await this.db.query<MessageRow>(
      'SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY created_at ASC, id ASC',
      [sessionId, sinceId],
    );
  }

  /** Delete a single message by id. */
  async deleteById(id: number): Promise<void> {
    await this.db.run('DELETE FROM messages WHERE id = ?', [id]);
  }

  /** Delete a message and all subsequent messages in the same session (for context cleanup). */
  async deleteFromId(sessionId: string, fromId: number): Promise<void> {
    await this.db.run('DELETE FROM messages WHERE session_id = ? AND id >= ?', [sessionId, fromId]);
  }
}
