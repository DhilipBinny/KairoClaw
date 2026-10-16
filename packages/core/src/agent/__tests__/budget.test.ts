import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkBudget } from '../budget.js';
import type { GatewayConfig } from '@agw/types';

function mockDb(todayCost: number, monthCost: number) {
  return {
    get: vi.fn(async (_sql: string, params: unknown[]) => {
      if (_sql.includes('SUM(cost_usd)')) {
        const dateParam = params[1] as string;
        const isMonthQuery = dateParam.endsWith('-01T00:00:00');
        return { cost: isMonthQuery ? monthCost : todayCost };
      }
      return undefined;
    }),
    query: vi.fn(async () => []),
    run: vi.fn(async () => {}),
  } as any;
}

function makeConfig(budget: {
  dailyCapUsd?: number;
  monthlyCapUsd?: number;
  enforcement?: string;
  downgradeModel?: string;
  alertThresholds?: number[];
}): GatewayConfig {
  return {
    agent: {
      timezone: 'UTC',
      budget: {
        dailyCapUsd: budget.dailyCapUsd ?? 0,
        monthlyCapUsd: budget.monthlyCapUsd ?? 0,
        enforcement: budget.enforcement ?? 'downgrade',
        downgradeModel: budget.downgradeModel ?? '',
        alertThresholds: budget.alertThresholds ?? [80, 95],
      },
    },
  } as any;
}

describe('budget checker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows when no budget is configured', async () => {
    const result = await checkBudget(mockDb(0, 0), makeConfig({}), 'tenant-1');
    expect(result.allowed).toBe(true);
  });

  it('allows when daily spend is under cap', async () => {
    const result = await checkBudget(
      mockDb(3.50, 0),
      makeConfig({ dailyCapUsd: 5 }),
      'tenant-1',
    );
    expect(result.allowed).toBe(true);
  });

  it('denies when daily spend hits cap and falls back to block without downgrade model', async () => {
    const result = await checkBudget(
      mockDb(5.01, 0),
      makeConfig({ dailyCapUsd: 5 }),
      'tenant-1',
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily budget exhausted');
    expect(result.enforcement).toBe('block');
  });

  it('denies when monthly spend hits cap', async () => {
    const result = await checkBudget(
      mockDb(1, 50.5),
      makeConfig({ monthlyCapUsd: 50 }),
      'tenant-1',
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Monthly budget exhausted');
  });

  it('respects enforcement mode from config', async () => {
    const result = await checkBudget(
      mockDb(10, 0),
      makeConfig({ dailyCapUsd: 5, enforcement: 'block' }),
      'tenant-1',
    );
    expect(result.allowed).toBe(false);
    expect(result.enforcement).toBe('block');
  });

  it('uses per-user override when provided', async () => {
    const result = await checkBudget(
      mockDb(3, 0),
      makeConfig({ dailyCapUsd: 10 }),
      'tenant-1',
      'user-1',
      { budget: { dailyCapUsd: 2 } },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily budget exhausted');
  });

  it('daily check runs before monthly', async () => {
    const result = await checkBudget(
      mockDb(6, 100),
      makeConfig({ dailyCapUsd: 5, monthlyCapUsd: 50 }),
      'tenant-1',
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily');
  });

  it('returns cost details in result', async () => {
    const result = await checkBudget(
      mockDb(3.5, 25),
      makeConfig({ dailyCapUsd: 5, monthlyCapUsd: 50 }),
      'tenant-1',
    );
    expect(result.dailyUsed).toBe(3.5);
    expect(result.dailyCap).toBe(5);
    expect(result.monthlyUsed).toBe(25);
    expect(result.monthlyCap).toBe(50);
  });

  it('returns downgradeModel when configured', async () => {
    const result = await checkBudget(
      mockDb(10, 0),
      makeConfig({ dailyCapUsd: 5, enforcement: 'downgrade', downgradeModel: 'anthropic/claude-haiku-3-5' }),
      'tenant-1',
    );
    expect(result.allowed).toBe(false);
    expect(result.enforcement).toBe('downgrade');
    expect(result.downgradeModel).toBe('anthropic/claude-haiku-3-5');
  });

  it('falls back to block when downgrade has no model configured', async () => {
    const result = await checkBudget(
      mockDb(10, 0),
      makeConfig({ dailyCapUsd: 5, enforcement: 'downgrade' }),
      'tenant-1',
    );
    expect(result.allowed).toBe(false);
    expect(result.enforcement).toBe('block');
    expect(result.downgradeModel).toBeUndefined();
  });
});
