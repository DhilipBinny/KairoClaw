import type { DatabaseAdapter } from '../index.js';

export interface PendingSenderRow {
  id: number;
  channel: string;
  sender_id: string;
  sender_name: string;
  first_seen: string;
  last_seen: string;
  message_count: number;
  status: string;
}

export class PendingSenderRepository {
  constructor(private db: DatabaseAdapter) {}

  /** Find a sender by channel + sender_id with specific statuses. */
  async findBySenderId(channel: string, senderId: string, statuses: string[]): Promise<PendingSenderRow | undefined> {
    const placeholders = statuses.map(() => '?').join(',');
    return await this.db.get<PendingSenderRow>(
      `SELECT * FROM pending_senders WHERE channel = ? AND sender_id = ? AND status IN (${placeholders})`,
      [channel, senderId, ...statuses],
    );
  }

  /** Update last_seen, message_count, and optionally sender_name for matching rows. */
  async updateActivity(channel: string, senderId: string, senderName: string | null, statuses: string[]): Promise<void> {
    const now = new Date().toISOString();
    const placeholders = statuses.map(() => '?').join(',');
    if (senderName !== null) {
      await this.db.run(
        `UPDATE pending_senders SET sender_name = ?, last_seen = ?, message_count = message_count + 1 WHERE channel = ? AND sender_id = ? AND status IN (${placeholders})`,
        [senderName, now, channel, senderId, ...statuses],
      );
    } else {
      await this.db.run(
        `UPDATE pending_senders SET last_seen = ?, message_count = message_count + 1 WHERE channel = ? AND sender_id = ? AND status IN (${placeholders})`,
        [now, channel, senderId, ...statuses],
      );
    }
  }

  /** Count senders by channel and status. */
  async countByStatus(channel: string, status: string): Promise<number> {
    const row = await this.db.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM pending_senders WHERE channel = ? AND status = ?',
      [channel, status],
    );
    return row?.c ?? 0;
  }

  /** Count all senders with a given status (across all channels). */
  async countAllByStatus(status: string): Promise<number> {
    const row = await this.db.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM pending_senders WHERE status = ?',
      [status],
    );
    return row?.c ?? 0;
  }

  /** Delete the oldest entry by last_seen for a given channel and status. */
  async evictOldest(channel: string, status: string): Promise<void> {
    await this.db.run(
      'DELETE FROM pending_senders WHERE id = (SELECT id FROM pending_senders WHERE channel = ? AND status = ? ORDER BY last_seen ASC LIMIT 1)',
      [channel, status],
    );
  }

  /** Evict entries over a cap for a given channel and status. */
  async evictOverCap(channel: string, status: string, cap: number): Promise<void> {
    await this.db.run(
      `DELETE FROM pending_senders WHERE id IN (
        SELECT id FROM pending_senders WHERE channel = ? AND status = ?
        ORDER BY last_seen ASC LIMIT max(0, (SELECT COUNT(*) FROM pending_senders WHERE channel = ? AND status = ?) - ?)
      )`,
      [channel, status, channel, status, cap - 1],
    );
  }

  /** Insert a new pending sender. */
  async insert(channel: string, senderId: string, senderName: string, status: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      'INSERT INTO pending_senders (channel, sender_id, sender_name, first_seen, last_seen, message_count, status) VALUES (?, ?, ?, ?, ?, 1, ?)',
      [channel, senderId, senderName, now, now, status],
    );
  }

  /** Upsert: insert or update if exists (for pending/rejection tracking). */
  async upsert(channel: string, senderId: string, senderName: string, status: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO pending_senders (channel, sender_id, sender_name, first_seen, last_seen, message_count, status)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(channel, sender_id) DO UPDATE SET
         sender_name = excluded.sender_name,
         last_seen = ?,
         message_count = message_count + 1,
         status = ?`,
      [channel, senderId, senderName, now, now, status, now, status],
    );
  }

  /** List senders by status, ordered by last_seen DESC. */
  async listByStatus(status: string, limit = 50): Promise<PendingSenderRow[]> {
    return await this.db.query<PendingSenderRow>(
      'SELECT * FROM pending_senders WHERE status = ? ORDER BY last_seen DESC LIMIT ?',
      [status, limit],
    );
  }

  /** Get a sender by id. */
  async getById(id: number | string): Promise<PendingSenderRow | undefined> {
    return await this.db.get<PendingSenderRow>(
      'SELECT * FROM pending_senders WHERE id = ?',
      [id],
    );
  }

  /** Update status (approve/reject). */
  async updateStatus(id: number | string, status: string): Promise<void> {
    await this.db.run('UPDATE pending_senders SET status = ? WHERE id = ?', [status, id]);
  }

  /**
   * Record a sender sighting with cap enforcement.
   * This is the common pattern used by both telegram and whatsapp:
   * - If sender exists with matching status, update activity
   * - If not, check cap, evict oldest if needed, insert new
   */
  async recordSighting(channel: string, senderId: string, senderName: string, status: string, cap: number): Promise<void> {
    const existing = await this.findBySenderId(channel, senderId, [status]);
    if (existing) {
      await this.updateActivity(channel, senderId, senderName, [status]);
    } else {
      const count = await this.countByStatus(channel, status);
      if (count >= cap) {
        await this.evictOldest(channel, status);
      }
      await this.insert(channel, senderId, senderName, status);
    }
  }

  /**
   * Record a group/sender that may have seen or pending status.
   * Checks resolved (approved/rejected) first, skips if found.
   * Then checks existing seen/pending, updates or inserts with cap.
   */
  async recordWithResolutionCheck(
    channel: string, senderId: string, senderName: string, status: 'seen' | 'pending', cap: number,
  ): Promise<void> {
    // Skip if already resolved
    const resolved = await this.findBySenderId(channel, senderId, ['approved', 'rejected']);
    if (resolved) return;

    const existing = await this.findBySenderId(channel, senderId, ['seen', 'pending']);
    if (existing) {
      await this.updateActivity(channel, senderId, senderName, ['seen', 'pending']);
    } else {
      const count = await this.countByStatus(channel, status);
      if (count >= cap) {
        await this.evictOldest(channel, status);
      }
      await this.insert(channel, senderId, senderName, status);
    }
  }
}
