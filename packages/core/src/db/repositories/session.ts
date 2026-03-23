import type { DatabaseAdapter } from '../index.js';

export interface SessionRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  channel: string;
  chat_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  turns: number;
  metadata: string; // JSON
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export class SessionRepository {
  constructor(private db: DatabaseAdapter) {}

  create(session: {
    id: string;
    tenantId: string;
    userId?: string;
    channel: string;
    chatId?: string;
    model?: string;
  }): SessionRow {
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO sessions (id, tenant_id, user_id, channel, chat_id, model, input_tokens, output_tokens, turns, metadata, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, '{}', ?, ?, NULL)`,
      [
        session.id,
        session.tenantId,
        session.userId ?? null,
        session.channel,
        session.chatId ?? null,
        session.model ?? null,
        now,
        now,
      ],
    );

    return this.getById(session.id)!;
  }

  getById(id: string, tenantId?: string): SessionRow | undefined {
    if (tenantId) {
      return this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    }
    return this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [id]);
  }

  listByTenant(tenantId: string, limit = 100): SessionRow[] {
    return this.db.query<SessionRow>(
      'SELECT * FROM sessions WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?',
      [tenantId, limit],
    );
  }

  update(id: string, data: Partial<{ model: string; metadata: string; updated_at: string }>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.model !== undefined) {
      fields.push('model = ?');
      values.push(data.model);
    }
    if (data.metadata !== undefined) {
      fields.push('metadata = ?');
      values.push(data.metadata);
    }

    fields.push('updated_at = ?');
    values.push(data.updated_at ?? new Date().toISOString());
    values.push(id);

    this.db.run(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  addUsage(id: string, inputTokens: number, outputTokens: number): void {
    this.db.run(
      `UPDATE sessions SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = ? WHERE id = ?`,
      [inputTokens, outputTokens, new Date().toISOString(), id],
    );
  }

  incrementTurns(id: string): void {
    this.db.run(
      `UPDATE sessions SET turns = turns + 1, updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), id],
    );
  }

  delete(id: string, tenantId?: string): void {
    if (tenantId) {
      this.db.run('DELETE FROM sessions WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    } else {
      this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
    }
  }

  /** Delete a session and all child records (tool_calls, usage_records, messages). */
  deleteWithCascade(id: string): void {
    this.db.run('DELETE FROM tool_calls WHERE session_id = ?', [id]);
    this.db.run('DELETE FROM usage_records WHERE session_id = ?', [id]);
    this.db.run('DELETE FROM messages WHERE session_id = ?', [id]);
    this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
  }

  /** Clean up orphaned internal sessions (sub-agents that didn't clean up). Returns count cleaned. */
  cleanupOrphans(): number {
    const orphaned = this.db.query<{ id: string }>('SELECT id FROM sessions WHERE channel = ?', ['internal']);
    for (const { id } of orphaned) {
      this.deleteWithCascade(id);
    }
    return orphaned.length;
  }

  /** Count sessions. */
  count(): number {
    const row = this.db.get<{ c: number }>('SELECT COUNT(*) as c FROM sessions');
    return row?.c ?? 0;
  }

  /** Set the turns count for a session. */
  setTurns(id: string, turns: number): void {
    this.db.run('UPDATE sessions SET turns = ?, updated_at = ? WHERE id = ?', [turns, new Date().toISOString(), id]);
  }

  /** Count user turns for a session. */
  countUserTurns(sessionId: string): number {
    const row = this.db.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND role = ?',
      [sessionId, 'user'],
    );
    return row?.c ?? 0;
  }
}
