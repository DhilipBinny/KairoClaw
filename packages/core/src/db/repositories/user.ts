import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../index.js';

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string | null;
  name: string;
  role: string;
  api_key_hash: string | null;
  settings: string; // JSON
  elevated: number; // 0 or 1
  active: number; // 0 or 1
  deactivated_at: string | null;
  created_at: string;
  updated_at: string;
}

export class UserRepository {
  constructor(private db: DatabaseAdapter) {}

  async create(user: {
    tenantId: string;
    name: string;
    email?: string;
    role?: string;
    apiKeyHash?: string;
  }): Promise<UserRow> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await this.db.run(
      `INSERT INTO users (id, tenant_id, email, name, role, api_key_hash, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      [
        id,
        user.tenantId,
        user.email ?? null,
        user.name,
        user.role ?? 'user',
        user.apiKeyHash ?? null,
        now,
        now,
      ],
    );

    return (await this.getById(id))!;
  }

  async getById(id: string, tenantId?: string): Promise<UserRow | undefined> {
    if (tenantId) {
      return await this.db.get<UserRow>('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    }
    return await this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  }

  async getByApiKeyHash(hash: string): Promise<UserRow | undefined> {
    return await this.db.get<UserRow>('SELECT * FROM users WHERE api_key_hash = ?', [hash]);
  }

  async listByTenant(tenantId: string): Promise<UserRow[]> {
    return await this.db.query<UserRow>('SELECT * FROM users WHERE tenant_id = ?', [tenantId]);
  }

  async update(id: string, data: Partial<{
    name: string; email: string; role: string; settings: string;
    elevated: number; apiKeyHash: string;
  }>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) {
      fields.push('name = ?');
      values.push(data.name);
    }
    if (data.email !== undefined) {
      fields.push('email = ?');
      values.push(data.email);
    }
    if (data.role !== undefined) {
      fields.push('role = ?');
      values.push(data.role);
    }
    if (data.settings !== undefined) {
      fields.push('settings = ?');
      values.push(data.settings);
    }
    if (data.elevated !== undefined) {
      fields.push('elevated = ?');
      values.push(data.elevated);
    }
    if (data.apiKeyHash !== undefined) {
      fields.push('api_key_hash = ?');
      values.push(data.apiKeyHash);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    await this.db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  async deactivate(id: string, tenantId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      'UPDATE users SET active = 0, deactivated_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [now, now, id, tenantId],
    );
  }

  async reactivate(id: string, tenantId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      'UPDATE users SET active = 1, deactivated_at = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [now, id, tenantId],
    );
  }

  async delete(id: string, tenantId?: string): Promise<void> {
    if (tenantId) {
      await this.db.run('DELETE FROM users WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    } else {
      await this.db.run('DELETE FROM users WHERE id = ?', [id]);
    }
  }

  async hardDelete(id: string, tenantId: string): Promise<void> {
    // Cascade: delete sender_links, usage_records, then sessions (messages cascade from sessions), then user
    await this.db.run('DELETE FROM sender_links WHERE user_id = ? AND tenant_id = ?', [id, tenantId]);
    await this.db.run('DELETE FROM usage_records WHERE user_id = ? AND tenant_id = ?', [id, tenantId]);
    // Nullify user_id on sessions (keep sessions for audit), then delete user
    await this.db.run('UPDATE sessions SET user_id = NULL WHERE user_id = ? AND tenant_id = ?', [id, tenantId]);
    await this.db.run('DELETE FROM users WHERE id = ? AND tenant_id = ?', [id, tenantId]);
  }
}
