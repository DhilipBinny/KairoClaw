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

  async update(id: string, data: Partial<{ name: string; email: string; role: string; settings: string }>): Promise<void> {
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

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    await this.db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  async delete(id: string, tenantId?: string): Promise<void> {
    if (tenantId) {
      await this.db.run('DELETE FROM users WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    } else {
      await this.db.run('DELETE FROM users WHERE id = ?', [id]);
    }
  }
}
