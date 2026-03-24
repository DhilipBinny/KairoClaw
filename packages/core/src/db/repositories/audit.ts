import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../index.js';

export interface AuditRow {
  id: number;
  tenant_id: string;
  user_id: string | null;
  action: string;
  resource: string | null;
  details: string; // JSON
  ip_address: string | null;
  prev_hash: string;
  entry_hash: string;
  created_at: string;
}

export class AuditRepository {
  constructor(private db: DatabaseAdapter) {}

  async append(entry: {
    tenantId: string;
    userId?: string;
    action: string;
    resource?: string;
    details?: Record<string, unknown>;
    ipAddress?: string;
  }): Promise<AuditRow> {
    const now = new Date().toISOString();
    const detailsJson = JSON.stringify(entry.details ?? {});

    // Wrap read-last-hash + insert in a transaction to prevent race conditions.
    // PostgreSQL: FOR UPDATE locks the row to serialize concurrent writers.
    // SQLite: single-writer, inherently serialized — falls back to plain SELECT.
    let entryHash = '';
    await this.db.transaction(async () => {
      let lastEntry: { entry_hash: string } | undefined;
      try {
        lastEntry = await this.db.get<{ entry_hash: string }>(
          'SELECT entry_hash FROM audit_log WHERE tenant_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE',
          [entry.tenantId],
        );
      } catch {
        lastEntry = await this.db.get<{ entry_hash: string }>(
          'SELECT entry_hash FROM audit_log WHERE tenant_id = ? ORDER BY id DESC LIMIT 1',
          [entry.tenantId],
        );
      }
      const prevHash = lastEntry?.entry_hash ?? '';

      entryHash = crypto
        .createHash('sha256')
        .update(prevHash + entry.action + detailsJson + now)
        .digest('hex');

      await this.db.run(
        `INSERT INTO audit_log (tenant_id, user_id, action, resource, details, ip_address, prev_hash, entry_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.tenantId,
          entry.userId ?? null,
          entry.action,
          entry.resource ?? null,
          detailsJson,
          entry.ipAddress ?? null,
          prevHash,
          entryHash,
          now,
        ],
      );
    });

    // Look up by unique entry_hash (avoids lastInsertRowid dependency)
    return (await this.db.get<AuditRow>('SELECT * FROM audit_log WHERE entry_hash = ?', [entryHash]))!;
  }

  async listByTenant(tenantId: string, limit = 100, offset = 0): Promise<AuditRow[]> {
    return await this.db.query<AuditRow>(
      'SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
      [tenantId, limit, offset],
    );
  }

  async listByAction(tenantId: string, action: string, limit = 100): Promise<AuditRow[]> {
    return await this.db.query<AuditRow>(
      'SELECT * FROM audit_log WHERE tenant_id = ? AND action = ? ORDER BY id DESC LIMIT ?',
      [tenantId, action, limit],
    );
  }

  async verifyChain(tenantId: string): Promise<{ valid: boolean; brokenAt?: number }> {
    const entries = await this.db.query<AuditRow>(
      'SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY id ASC',
      [tenantId],
    );

    let expectedPrevHash = '';

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      // Verify prev_hash links correctly
      if (entry.prev_hash !== expectedPrevHash) {
        return { valid: false, brokenAt: i };
      }

      // Recompute the entry hash
      const computedHash = crypto
        .createHash('sha256')
        .update(expectedPrevHash + entry.action + entry.details + entry.created_at)
        .digest('hex');

      if (entry.entry_hash !== computedHash) {
        return { valid: false, brokenAt: i };
      }

      expectedPrevHash = entry.entry_hash;
    }

    return { valid: true };
  }
}
