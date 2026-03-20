/**
 * One-time migration: seed outbound allowlists from existing active cron jobs.
 *
 * When outbound security (session-only policy) is first deployed, existing
 * cron delivery targets may not have sessions. This migration reads all active
 * crons, extracts their delivery targets, and adds any that would be blocked
 * to the channel's outboundAllowlist — so existing valid crons keep working.
 *
 * Safe to run multiple times — only adds targets not already in the list.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GatewayConfig } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import type { CronScheduler } from '../cron/scheduler.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('security');

export function migrateOutboundAllowlist(
  scheduler: CronScheduler,
  config: GatewayConfig,
  db: DatabaseAdapter,
): void {
  const jobs = scheduler.list();
  const activeJobs = jobs.filter(j => j.enabled);
  if (activeJobs.length === 0) return;

  // Collect all delivery targets from active crons
  const targets: Array<{ channel: string; to: string }> = [];

  for (const job of activeJobs) {
    const delivery = job.delivery;
    if (!delivery || typeof delivery === 'string') continue;
    if (delivery.mode !== 'announce') continue;

    if (delivery.targets && delivery.targets.length > 0) {
      for (const t of delivery.targets) {
        if (t.to && (t.channel === 'whatsapp' || t.channel === 'telegram')) {
          targets.push({ channel: t.channel, to: t.to });
        }
      }
    } else if (delivery.channel && delivery.to) {
      // Legacy format
      const channels = Array.isArray(delivery.channel) ? delivery.channel : [delivery.channel];
      for (const ch of channels) {
        if (ch === 'whatsapp' || ch === 'telegram') {
          targets.push({ channel: ch, to: delivery.to });
        }
      }
    }
  }

  if (targets.length === 0) return;

  // Check which targets would be blocked (no session)
  const needsAllowlist: Array<{ channel: 'whatsapp' | 'telegram'; to: string }> = [];

  for (const { channel, to } of targets) {
    const chatIdPattern = `${channel}:${to}`;
    const session = db.get<{ id: string }>(
      'SELECT id FROM sessions WHERE channel = ? AND chat_id = ? LIMIT 1',
      [channel, chatIdPattern],
    );
    if (!session) {
      // Also try LIKE fallback
      const alt = db.get<{ id: string }>(
        'SELECT id FROM sessions WHERE chat_id LIKE ? LIMIT 1',
        [`%${to}%`],
      );
      if (!alt) {
        needsAllowlist.push({ channel: channel as 'whatsapp' | 'telegram', to });
      }
    }
  }

  if (needsAllowlist.length === 0) return;

  // Add to config allowlists
  let configChanged = false;
  const stateDir = config._stateDir || '';
  const configPath = path.join(stateDir, 'config.json');

  let rawConfig: Record<string, unknown>;
  try {
    rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    log.warn('Could not read config.json for outbound allowlist migration');
    return;
  }

  for (const { channel, to } of needsAllowlist) {
    // Ensure config path exists
    if (!rawConfig.channels) rawConfig.channels = {};
    const channels = rawConfig.channels as Record<string, Record<string, unknown>>;
    if (!channels[channel]) channels[channel] = {};
    const chConfig = channels[channel];
    if (!Array.isArray(chConfig.outboundAllowlist)) chConfig.outboundAllowlist = [];
    const list = chConfig.outboundAllowlist as string[];

    // Check if already in list (match phone part too)
    const toPhone = to.replace(/@.*$/, '');
    const alreadyExists = list.some(entry => {
      const entryPhone = entry.replace(/@.*$/, '');
      return entry === to || entryPhone === toPhone;
    });

    if (!alreadyExists) {
      list.push(to);
      // Also update runtime config
      const runtimeCh = (config.channels as any)?.[channel];
      if (runtimeCh) {
        if (!Array.isArray(runtimeCh.outboundAllowlist)) runtimeCh.outboundAllowlist = [];
        runtimeCh.outboundAllowlist.push(to);
      }
      configChanged = true;
      log.info({ channel, to }, 'Outbound allowlist: added existing cron delivery target');
    }
  }

  if (configChanged) {
    try {
      fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), { mode: 0o600 });
      log.info({ count: needsAllowlist.length }, 'Outbound allowlist migration: config.json updated');
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'Failed to write config.json during outbound migration');
    }
  }
}
