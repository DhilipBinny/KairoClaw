import type { DatabaseAdapter } from '../index.js';

export interface SenderLinkRow {
  id: number;
  tenant_id: string;
  channel_type: string;
  sender_id: string;
  user_id: string;
  linked_at: string;
  linked_by: string | null;
}

export class SenderLinkRepository {
  constructor(private db: DatabaseAdapter) {}

  async link(data: {
    tenantId: string;
    channelType: string;
    senderId: string;
    userId: string;
    linkedBy?: string;
  }): Promise<SenderLinkRow> {
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO sender_links (tenant_id, channel_type, sender_id, user_id, linked_at, linked_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, channel_type, sender_id) DO UPDATE SET
         user_id = excluded.user_id,
         linked_at = excluded.linked_at,
         linked_by = excluded.linked_by`,
      [data.tenantId, data.channelType, data.senderId, data.userId, now, data.linkedBy ?? null],
    );

    // Backfill existing sessions: set user_id on unowned sessions from this sender
    const chatIdPrefix = `${data.channelType}:${data.senderId}`;
    await this.db.run(
      `UPDATE sessions SET user_id = ? WHERE tenant_id = ? AND chat_id = ? AND user_id IS NULL`,
      [data.userId, data.tenantId, chatIdPrefix],
    );

    const row = await this.db.get<SenderLinkRow>(
      `SELECT * FROM sender_links WHERE tenant_id = ? AND channel_type = ? AND sender_id = ?`,
      [data.tenantId, data.channelType, data.senderId],
    );
    return row!;
  }

  async unlink(id: number, tenantId: string): Promise<void> {
    await this.db.run('DELETE FROM sender_links WHERE id = ? AND tenant_id = ?', [id, tenantId]);
  }

  async findByChannelSender(tenantId: string, channelType: string, senderId: string): Promise<SenderLinkRow | undefined> {
    return await this.db.get<SenderLinkRow>(
      'SELECT * FROM sender_links WHERE tenant_id = ? AND channel_type = ? AND sender_id = ?',
      [tenantId, channelType, senderId],
    );
  }

  async listByUser(tenantId: string, userId: string): Promise<SenderLinkRow[]> {
    return await this.db.query<SenderLinkRow>(
      'SELECT * FROM sender_links WHERE tenant_id = ? AND user_id = ? ORDER BY linked_at DESC',
      [tenantId, userId],
    );
  }

  async listByTenant(tenantId: string): Promise<SenderLinkRow[]> {
    return await this.db.query<SenderLinkRow>(
      'SELECT * FROM sender_links WHERE tenant_id = ? ORDER BY linked_at DESC',
      [tenantId],
    );
  }

  async getById(id: number, tenantId: string): Promise<SenderLinkRow | undefined> {
    return await this.db.get<SenderLinkRow>('SELECT * FROM sender_links WHERE id = ? AND tenant_id = ?', [id, tenantId]);
  }
}
