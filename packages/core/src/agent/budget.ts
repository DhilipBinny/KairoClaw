import type { GatewayConfig } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import { UsageRepository } from '../db/repositories/usage.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('system');

export type BudgetEnforcement = 'block' | 'downgrade' | 'alert';

export interface BudgetCheckResult {
  allowed: boolean;
  enforcement: BudgetEnforcement;
  reason?: string;
  dailyUsed?: number;
  dailyCap?: number;
  monthlyUsed?: number;
  monthlyCap?: number;
}

interface BudgetConfig {
  dailyCapUsd: number;
  monthlyCapUsd: number;
  enforcement: BudgetEnforcement;
  alertThresholds: number[];
}

function getBudgetConfig(config: GatewayConfig, userSettings?: Record<string, unknown>): BudgetConfig {
  const agentBudget = (config.agent as any)?.budget ?? {};
  const base: BudgetConfig = {
    dailyCapUsd: agentBudget.dailyCapUsd ?? 0,
    monthlyCapUsd: agentBudget.monthlyCapUsd ?? 0,
    enforcement: agentBudget.enforcement ?? 'downgrade',
    alertThresholds: agentBudget.alertThresholds ?? [80, 95],
  };

  if (userSettings?.budget && typeof userSettings.budget === 'object') {
    const userBudget = userSettings.budget as Record<string, unknown>;
    if (typeof userBudget.dailyCapUsd === 'number' && userBudget.dailyCapUsd > 0) {
      base.dailyCapUsd = userBudget.dailyCapUsd;
    }
    if (typeof userBudget.monthlyCapUsd === 'number' && userBudget.monthlyCapUsd > 0) {
      base.monthlyCapUsd = userBudget.monthlyCapUsd;
    }
  }

  return base;
}

export async function checkBudget(
  db: DatabaseAdapter,
  config: GatewayConfig,
  tenantId: string,
  userId?: string,
  userSettings?: Record<string, unknown>,
  alertEmitter?: (type: string, severity: string, title: string, message: string, labels: Record<string, string>) => void,
): Promise<BudgetCheckResult> {
  const budget = getBudgetConfig(config, userSettings);
  const hasDailyCap = budget.dailyCapUsd > 0;
  const hasMonthlyCap = budget.monthlyCapUsd > 0;

  if (!hasDailyCap && !hasMonthlyCap) {
    return { allowed: true, enforcement: budget.enforcement };
  }

  const timezone = config.agent?.timezone || 'UTC';
  const usageRepo = new UsageRepository(db);

  let dailyUsed = 0;
  let monthlyUsed = 0;

  if (hasDailyCap) {
    dailyUsed = await usageRepo.getTodayCost(tenantId, timezone, userId);
  }
  if (hasMonthlyCap) {
    monthlyUsed = await usageRepo.getMonthCost(tenantId, timezone, userId);
  }

  const result: BudgetCheckResult = {
    allowed: true,
    enforcement: budget.enforcement,
    dailyUsed,
    dailyCap: budget.dailyCapUsd,
    monthlyUsed,
    monthlyCap: budget.monthlyCapUsd,
  };

  if (hasDailyCap) {
    emitThresholdAlerts(budget, dailyUsed, budget.dailyCapUsd, 'daily', tenantId, userId, alertEmitter);
    if (dailyUsed >= budget.dailyCapUsd) {
      result.allowed = false;
      result.reason = `Daily budget exhausted ($${dailyUsed.toFixed(2)} / $${budget.dailyCapUsd.toFixed(2)})`;
    }
  }

  if (hasMonthlyCap && result.allowed) {
    emitThresholdAlerts(budget, monthlyUsed, budget.monthlyCapUsd, 'monthly', tenantId, userId, alertEmitter);
    if (monthlyUsed >= budget.monthlyCapUsd) {
      result.allowed = false;
      result.reason = `Monthly budget exhausted ($${monthlyUsed.toFixed(2)} / $${budget.monthlyCapUsd.toFixed(2)})`;
    }
  }

  if (!result.allowed) {
    log.warn({ userId, tenantId, enforcement: budget.enforcement, reason: result.reason }, 'Budget limit reached');
  }

  return result;
}

const _alertedThresholds = new Map<string, Set<number>>();

function emitThresholdAlerts(
  budget: BudgetConfig,
  used: number,
  cap: number,
  period: 'daily' | 'monthly',
  tenantId: string,
  userId: string | undefined,
  alertEmitter?: (type: string, severity: string, title: string, message: string, labels: Record<string, string>) => void,
): void {
  if (!alertEmitter || cap <= 0) return;

  const pct = (used / cap) * 100;
  const key = `${tenantId}:${userId ?? 'tenant'}:${period}`;

  let alerted = _alertedThresholds.get(key);
  if (!alerted) {
    alerted = new Set();
    _alertedThresholds.set(key, alerted);
  }

  for (const threshold of budget.alertThresholds) {
    if (pct >= threshold && !alerted.has(threshold)) {
      alerted.add(threshold);
      const who = userId ? `user ${userId}` : 'tenant';
      alertEmitter(
        'budget_threshold',
        threshold >= 95 ? 'critical' : 'warning',
        `${period} budget ${threshold}% reached`,
        `${who} has used $${used.toFixed(2)} of $${cap.toFixed(2)} ${period} budget (${pct.toFixed(0)}%)`,
        { tenantId, userId: userId ?? '', period, threshold: String(threshold) },
      );
    }
  }
}
