import type { DatabaseAdapter } from '../index.js';

export interface UsageRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  session_id: string | null;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  created_at: string;
}

export interface UsageSummary {
  totalInput: number;
  totalOutput: number;
  totalCost: number;
  byModel: Record<string, { input: number; output: number; cost: number }>;
}

export class UsageRepository {
  constructor(private db: DatabaseAdapter) {}

  async record(usage: {
    tenantId: string;
    userId?: string;
    sessionId?: string;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
  }): Promise<void> {
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO usage_records (tenant_id, user_id, session_id, model, provider, input_tokens, output_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        usage.tenantId,
        usage.userId ?? null,
        usage.sessionId ?? null,
        usage.model,
        usage.provider,
        usage.inputTokens,
        usage.outputTokens,
        usage.costUsd ?? 0,
        now,
      ],
    );
  }

  async summarizeByTenant(tenantId: string, days = 30): Promise<UsageSummary> {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    const totals = await this.db.get<{ total_input: number; total_output: number; total_cost: number }>(
      `SELECT COALESCE(SUM(input_tokens), 0) as total_input,
              COALESCE(SUM(output_tokens), 0) as total_output,
              COALESCE(SUM(cost_usd), 0) as total_cost
       FROM usage_records WHERE tenant_id = ? AND created_at >= ?`,
      [tenantId, cutoff],
    );

    const byModelRows = await this.db.query<{
      model: string;
      input: number;
      output: number;
      cost: number;
    }>(
      `SELECT model,
              COALESCE(SUM(input_tokens), 0) as input,
              COALESCE(SUM(output_tokens), 0) as output,
              COALESCE(SUM(cost_usd), 0) as cost
       FROM usage_records WHERE tenant_id = ? AND created_at >= ?
       GROUP BY model`,
      [tenantId, cutoff],
    );

    const byModel: Record<string, { input: number; output: number; cost: number }> = {};
    for (const row of byModelRows) {
      byModel[row.model] = { input: row.input, output: row.output, cost: row.cost };
    }

    return {
      totalInput: totals?.total_input ?? 0,
      totalOutput: totals?.total_output ?? 0,
      totalCost: totals?.total_cost ?? 0,
      byModel,
    };
  }

  async summarizeByUser(tenantId: string, userId: string, days = 30): Promise<UsageSummary> {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    const totals = await this.db.get<{ total_input: number; total_output: number; total_cost: number }>(
      `SELECT COALESCE(SUM(input_tokens), 0) as total_input,
              COALESCE(SUM(output_tokens), 0) as total_output,
              COALESCE(SUM(cost_usd), 0) as total_cost
       FROM usage_records WHERE tenant_id = ? AND user_id = ? AND created_at >= ?`,
      [tenantId, userId, cutoff],
    );

    const byModelRows = await this.db.query<{
      model: string;
      input: number;
      output: number;
      cost: number;
    }>(
      `SELECT model,
              COALESCE(SUM(input_tokens), 0) as input,
              COALESCE(SUM(output_tokens), 0) as output,
              COALESCE(SUM(cost_usd), 0) as cost
       FROM usage_records WHERE tenant_id = ? AND user_id = ? AND created_at >= ?
       GROUP BY model`,
      [tenantId, userId, cutoff],
    );

    const byModel: Record<string, { input: number; output: number; cost: number }> = {};
    for (const row of byModelRows) {
      byModel[row.model] = { input: row.input, output: row.output, cost: row.cost };
    }

    return {
      totalInput: totals?.total_input ?? 0,
      totalOutput: totals?.total_output ?? 0,
      totalCost: totals?.total_cost ?? 0,
      byModel,
    };
  }

  async summarizeByDateRange(tenantId: string, startDate: string, endDate: string): Promise<UsageRow[]> {
    return await this.db.query<UsageRow>(
      `SELECT * FROM usage_records WHERE tenant_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC`,
      [tenantId, startDate, endDate],
    );
  }

  async summarizeAllUsers(tenantId: string, days = 30): Promise<Array<{ user_id: string; total_input: number; total_output: number; total_cost: number; request_count: number }>> {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    return await this.db.query(
      `SELECT user_id,
              COALESCE(SUM(input_tokens), 0) as total_input,
              COALESCE(SUM(output_tokens), 0) as total_output,
              COALESCE(SUM(cost_usd), 0) as total_cost,
              COUNT(*) as request_count
       FROM usage_records WHERE tenant_id = ? AND created_at >= ? AND user_id IS NOT NULL
       GROUP BY user_id`,
      [tenantId, cutoff],
    );
  }
}
