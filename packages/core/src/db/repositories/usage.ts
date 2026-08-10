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
  totalRequests: number;
  byModel: Array<{ model: string; input: number; output: number; cost: number; requests: number }>;
  byDay: Array<{ date: string; input: number; output: number; cost: number; requests: number }>;
  byUser?: Array<{ user_id: string; user_name: string; input: number; output: number; cost: number; requests: number; last_active: string }>;
}

const MS_PER_DAY = 86_400_000;

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
    const cutoff = new Date(Date.now() - days * MS_PER_DAY).toISOString();

    const totals = await this.db.get<{
      total_input: number; total_output: number; total_cost: number; total_requests: number;
    }>(
      `SELECT COALESCE(SUM(input_tokens), 0) as total_input,
              COALESCE(SUM(output_tokens), 0) as total_output,
              COALESCE(SUM(cost_usd), 0) as total_cost,
              COUNT(*) as total_requests
       FROM usage_records WHERE tenant_id = ? AND created_at >= ?`,
      [tenantId, cutoff],
    );

    const byModelRows = await this.db.query<{
      model: string; input: number; output: number; cost: number; requests: number;
    }>(
      `SELECT model,
              COALESCE(SUM(input_tokens), 0) as input,
              COALESCE(SUM(output_tokens), 0) as output,
              COALESCE(SUM(cost_usd), 0) as cost,
              COUNT(*) as requests
       FROM usage_records WHERE tenant_id = ? AND created_at >= ?
       GROUP BY model
       ORDER BY cost DESC`,
      [tenantId, cutoff],
    );

    const byDayRows = await this.db.query<{
      date: string; input: number; output: number; cost: number; requests: number;
    }>(
      `SELECT DATE(created_at) as date,
              COALESCE(SUM(input_tokens), 0) as input,
              COALESCE(SUM(output_tokens), 0) as output,
              COALESCE(SUM(cost_usd), 0) as cost,
              COUNT(*) as requests
       FROM usage_records WHERE tenant_id = ? AND created_at >= ?
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [tenantId, cutoff],
    );

    return {
      totalInput: totals?.total_input ?? 0,
      totalOutput: totals?.total_output ?? 0,
      totalCost: totals?.total_cost ?? 0,
      totalRequests: totals?.total_requests ?? 0,
      byModel: byModelRows,
      byDay: byDayRows,
    };
  }

  async summarizeByUser(tenantId: string, userId: string, days = 30): Promise<UsageSummary> {
    const cutoff = new Date(Date.now() - days * MS_PER_DAY).toISOString();

    const totals = await this.db.get<{
      total_input: number; total_output: number; total_cost: number; total_requests: number;
    }>(
      `SELECT COALESCE(SUM(input_tokens), 0) as total_input,
              COALESCE(SUM(output_tokens), 0) as total_output,
              COALESCE(SUM(cost_usd), 0) as total_cost,
              COUNT(*) as total_requests
       FROM usage_records WHERE tenant_id = ? AND user_id = ? AND created_at >= ?`,
      [tenantId, userId, cutoff],
    );

    const byModelRows = await this.db.query<{
      model: string; input: number; output: number; cost: number; requests: number;
    }>(
      `SELECT model,
              COALESCE(SUM(input_tokens), 0) as input,
              COALESCE(SUM(output_tokens), 0) as output,
              COALESCE(SUM(cost_usd), 0) as cost,
              COUNT(*) as requests
       FROM usage_records WHERE tenant_id = ? AND user_id = ? AND created_at >= ?
       GROUP BY model
       ORDER BY cost DESC`,
      [tenantId, userId, cutoff],
    );

    const byDayRows = await this.db.query<{
      date: string; input: number; output: number; cost: number; requests: number;
    }>(
      `SELECT DATE(created_at) as date,
              COALESCE(SUM(input_tokens), 0) as input,
              COALESCE(SUM(output_tokens), 0) as output,
              COALESCE(SUM(cost_usd), 0) as cost,
              COUNT(*) as requests
       FROM usage_records WHERE tenant_id = ? AND user_id = ? AND created_at >= ?
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [tenantId, userId, cutoff],
    );

    return {
      totalInput: totals?.total_input ?? 0,
      totalOutput: totals?.total_output ?? 0,
      totalCost: totals?.total_cost ?? 0,
      totalRequests: totals?.total_requests ?? 0,
      byModel: byModelRows,
      byDay: byDayRows,
    };
  }

  async summarizeAllUsers(tenantId: string, days = 30): Promise<Array<{
    user_id: string; user_name: string; input: number; output: number; cost: number; requests: number; last_active: string;
  }>> {
    const cutoff = new Date(Date.now() - days * MS_PER_DAY).toISOString();
    return await this.db.query(
      `SELECT ur.user_id,
              COALESCE(u.name, 'Unknown') as user_name,
              COALESCE(SUM(ur.input_tokens), 0) as input,
              COALESCE(SUM(ur.output_tokens), 0) as output,
              COALESCE(SUM(ur.cost_usd), 0) as cost,
              COUNT(*) as requests,
              MAX(ur.created_at) as last_active
       FROM usage_records ur
       LEFT JOIN users u ON ur.user_id = u.id
       WHERE ur.tenant_id = ? AND ur.created_at >= ? AND ur.user_id IS NOT NULL
       GROUP BY ur.user_id
       ORDER BY cost DESC`,
      [tenantId, cutoff],
    );
  }
}
