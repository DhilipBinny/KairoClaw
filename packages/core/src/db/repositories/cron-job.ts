import type { DatabaseAdapter } from '../index.js';

export interface CronJobRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  name: string;
  schedule_type: string;
  schedule_value: string;
  timezone: string | null;
  prompt: string;
  delivery: string; // JSON
  enabled: number;
  last_run: string | null;
  last_result: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export class CronJobRepository {
  constructor(private db: DatabaseAdapter) {}

  async listByTenant(tenantId: string): Promise<CronJobRow[]> {
    return await this.db.query<CronJobRow>(
      'SELECT * FROM cron_jobs WHERE tenant_id = ? ORDER BY created_at ASC',
      [tenantId],
    );
  }

  async listByUser(tenantId: string, userId: string): Promise<CronJobRow[]> {
    return await this.db.query<CronJobRow>(
      'SELECT * FROM cron_jobs WHERE tenant_id = ? AND user_id = ? ORDER BY created_at ASC',
      [tenantId, userId],
    );
  }

  async getById(id: string, tenantId: string): Promise<CronJobRow | undefined> {
    return await this.db.get<CronJobRow>(
      'SELECT * FROM cron_jobs WHERE id = ? AND tenant_id = ?',
      [id, tenantId],
    );
  }

  async create(job: {
    id: string;
    tenantId: string;
    userId?: string | null;
    name: string;
    scheduleType: string;
    scheduleValue: string;
    timezone?: string;
    prompt: string;
    delivery: string;
    enabled?: boolean;
  }): Promise<CronJobRow> {
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO cron_jobs (id, tenant_id, user_id, name, schedule_type, schedule_value, timezone, prompt, delivery, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [job.id, job.tenantId, job.userId ?? null, job.name, job.scheduleType, job.scheduleValue,
       job.timezone ?? null, job.prompt, job.delivery, job.enabled !== false ? 1 : 0, now, now],
    );
    return (await this.getById(job.id, job.tenantId))!;
  }

  async update(id: string, tenantId: string, data: Partial<{
    name: string;
    scheduleType: string;
    scheduleValue: string;
    timezone: string;
    prompt: string;
    delivery: string;
    enabled: boolean;
    userId: string | null;
  }>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.scheduleType !== undefined) { fields.push('schedule_type = ?'); values.push(data.scheduleType); }
    if (data.scheduleValue !== undefined) { fields.push('schedule_value = ?'); values.push(data.scheduleValue); }
    if (data.timezone !== undefined) { fields.push('timezone = ?'); values.push(data.timezone); }
    if (data.prompt !== undefined) { fields.push('prompt = ?'); values.push(data.prompt); }
    if (data.delivery !== undefined) { fields.push('delivery = ?'); values.push(data.delivery); }
    if (data.enabled !== undefined) { fields.push('enabled = ?'); values.push(data.enabled ? 1 : 0); }
    if (data.userId !== undefined) { fields.push('user_id = ?'); values.push(data.userId); }

    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    values.push(tenantId);

    await this.db.run(`UPDATE cron_jobs SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`, values);
  }

  async updateLastRun(id: string, result?: string): Promise<void> {
    await this.db.run(
      'UPDATE cron_jobs SET last_run = ?, last_result = ?, run_count = run_count + 1 WHERE id = ?',
      [new Date().toISOString(), result ?? null, id],
    );
  }

  async delete(id: string, tenantId: string): Promise<void> {
    await this.db.run('DELETE FROM cron_jobs WHERE id = ? AND tenant_id = ?', [id, tenantId]);
  }
}
