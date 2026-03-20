import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../index.js';

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  settings: string; // JSON
  created_at: string;
  updated_at: string;
}

export class TenantRepository {
  constructor(private db: DatabaseAdapter) {}

  create(tenant: { name: string; slug: string; plan?: string }): TenantRow {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const plan = tenant.plan ?? 'free';

    this.db.run(
      `INSERT INTO tenants (id, name, slug, plan, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?)`,
      [id, tenant.name, tenant.slug, plan, now, now],
    );

    return this.getById(id)!;
  }

  getById(id: string): TenantRow | undefined {
    return this.db.get<TenantRow>('SELECT * FROM tenants WHERE id = ?', [id]);
  }

  getBySlug(slug: string): TenantRow | undefined {
    return this.db.get<TenantRow>('SELECT * FROM tenants WHERE slug = ?', [slug]);
  }

  update(id: string, data: Partial<Pick<TenantRow, 'name' | 'plan' | 'settings'>>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) {
      fields.push('name = ?');
      values.push(data.name);
    }
    if (data.plan !== undefined) {
      fields.push('plan = ?');
      values.push(data.plan);
    }
    if (data.settings !== undefined) {
      fields.push('settings = ?');
      values.push(data.settings);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.run(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  ensureDefault(): TenantRow {
    const id = 'default';
    this.db.run(
      `INSERT OR IGNORE INTO tenants (id, name, slug, plan, settings, created_at, updated_at)
       VALUES (?, 'Default', 'default', 'free', '{}', ?, ?)`,
      [id, new Date().toISOString(), new Date().toISOString()],
    );
    return this.db.get<TenantRow>('SELECT * FROM tenants WHERE id = ?', [id])!;
  }
}
