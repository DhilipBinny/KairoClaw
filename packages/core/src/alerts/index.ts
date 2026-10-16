import { createHash } from 'node:crypto';
import type {
  AlertEvent, AlertInstance, AlertDeliveryChannel,
  AlertsConfig, AlertTimingConfig, AlertThresholdsConfig,
  DatabaseAdapter,
} from '@agw/types';
import { ALERT_TYPES } from '@agw/types';
import { createModuleLogger } from '../observability/logger.js';
import { AlertStateStore } from './state.js';
import { ALERT_HISTORY_RETENTION_DAYS } from '../constants.js';

const log = createModuleLogger('alert');

export { AlertStateStore } from './state.js';

export function fingerprint(type: string, labels: Record<string, string>): string {
  const sorted = Object.keys(labels).sort().map(k => `${k}=${labels[k]}`).join(',');
  return createHash('sha256').update(`${type}:${sorted}`).digest('hex').slice(0, 16);
}

interface AlertManagerOptions {
  config: AlertsConfig;
  db?: DatabaseAdapter;
}

export class AlertManager {
  private store = new AlertStateStore();
  private channels: AlertDeliveryChannel[] = [];
  private config: AlertsConfig;
  private db?: DatabaseAdapter;
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private resolutionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inactiveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private enabled: boolean;

  constructor(opts: AlertManagerOptions) {
    this.config = opts.config;
    this.db = opts.db;
    this.enabled = opts.config.enabled;
  }

  registerChannel(channel: AlertDeliveryChannel): void {
    this.channels.push(channel);
    log.info({ channel: channel.name }, 'Alert delivery channel registered');
  }

  updateConfig(config: AlertsConfig): void {
    this.config = config;
    this.enabled = config.enabled;
  }

  getStore(): AlertStateStore {
    return this.store;
  }

  getFiringAlerts(): AlertInstance[] {
    return this.store.getFiring();
  }

  /**
   * Emit a failure event — something bad happened.
   */
  emitFailure(event: Omit<AlertEvent, 'fingerprint' | 'timestamp'>): void {
    if (!this.enabled) return;

    const fp = fingerprint(event.type, event.labels);
    const full: AlertEvent = { ...event, fingerprint: fp, timestamp: Date.now() };
    const thresholds = this.getThresholds(event.type);
    const inst = this.store.getOrCreate(fp, event.type, event.severity, event.labels, event.title, event.message);

    inst.title = event.title;
    inst.message = event.message;
    inst.severity = event.severity;
    inst.lastEventAt = Date.now();
    inst.failureCount++;
    inst.successCount = 0;

    this.clearResolutionTimer(fp);

    if (inst.state === 'inactive' || inst.state === 'resolved') {
      if (inst.failureCount >= thresholds.failureThreshold) {
        this.store.transition(fp, 'firing');
        this.notifyFiring(full, inst).catch(e => log.error({ err: e instanceof Error ? e.message : String(e) }, 'notifyFiring failed'));
      } else {
        this.store.transition(fp, 'pending');
        this.schedulePendingCheck(fp, full, thresholds);
      }
    } else if (inst.state === 'pending') {
      if (inst.failureCount >= thresholds.failureThreshold) {
        this.clearPendingTimer(fp);
        this.store.transition(fp, 'firing');
        this.notifyFiring(full, inst).catch(e => log.error({ err: e instanceof Error ? e.message : String(e) }, 'notifyFiring failed'));
      }
    } else if (inst.state === 'firing') {
      this.maybeRepeatNotify(full, inst);
    }
  }

  /**
   * Emit a success/healthy event — condition has cleared.
   */
  emitSuccess(type: string, labels: Record<string, string>): void {
    if (!this.enabled) return;

    const fp = fingerprint(type, labels);
    const inst = this.store.get(fp);
    if (!inst) return;

    const thresholds = this.getThresholds(type);
    inst.successCount++;
    inst.failureCount = 0;
    inst.lastEventAt = Date.now();

    if (inst.state === 'pending') {
      this.clearPendingTimer(fp);
      this.store.transition(fp, 'inactive');
    } else if (inst.state === 'firing') {
      if (inst.successCount >= thresholds.recoveryThreshold && !this.resolutionTimers.has(fp)) {
        this.scheduleResolution(fp, inst);
      }
    }
  }

  stop(): void {
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    for (const timer of this.resolutionTimers.values()) clearTimeout(timer);
    for (const timer of this.inactiveTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
    this.resolutionTimers.clear();
    this.inactiveTimers.clear();
  }

  async cleanupHistory(): Promise<void> {
    if (!this.db) return;
    try {
      const cutoff = new Date(Date.now() - ALERT_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const result = await this.db.run('DELETE FROM alert_history WHERE created_at < ?', [cutoff]);
      if (result.changes > 0) {
        log.info({ deleted: result.changes, retentionDays: ALERT_HISTORY_RETENTION_DAYS }, 'Alert history cleanup');
      }
    } catch (e) {
      log.error({ err: e instanceof Error ? e.message : String(e) }, 'Alert history cleanup failed');
    }
  }

  // ── Private helpers ──────────────────────────────────────────

  private getThresholds(eventType: string): AlertThresholdsConfig {
    const override = this.config.events[eventType];
    return {
      failureThreshold: override?.failureThreshold ?? this.config.thresholds.failureThreshold,
      recoveryThreshold: override?.recoveryThreshold ?? this.config.thresholds.recoveryThreshold,
    };
  }

  private getTiming(): AlertTimingConfig {
    return this.config.timing;
  }

  private isEventEnabled(eventType: string): boolean {
    const override = this.config.events[eventType];
    return override?.enabled !== false;
  }

  private getDeliveryChannelNames(eventType: string): string[] | null {
    const override = this.config.events[eventType];
    return override?.delivery ?? null;
  }

  private schedulePendingCheck(fp: string, event: AlertEvent, thresholds: AlertThresholdsConfig): void {
    this.clearPendingTimer(fp);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(fp);
      const inst = this.store.get(fp);
      if (!inst || inst.state !== 'pending') return;
      if (inst.failureCount >= thresholds.failureThreshold) {
        this.store.transition(fp, 'firing');
        this.notifyFiring(event, inst);
      } else {
        this.store.transition(fp, 'inactive');
      }
    }, this.getTiming().groupWaitMs);
    this.pendingTimers.set(fp, timer);
  }

  private scheduleResolution(fp: string, _inst: AlertInstance): void {
    this.clearResolutionTimer(fp);
    const timer = setTimeout(() => {
      this.resolutionTimers.delete(fp);
      const current = this.store.get(fp);
      if (!current || current.state !== 'firing') return;
      this.store.transition(fp, 'resolved');
      this.notifyResolved(current);
      const RESOLVED_TO_INACTIVE_MS = 60_000;
      const inactiveTimer = setTimeout(() => {
        this.inactiveTimers.delete(fp);
        const c = this.store.get(fp);
        if (c && c.state === 'resolved') {
          this.store.transition(fp, 'inactive');
        }
      }, RESOLVED_TO_INACTIVE_MS);
      this.inactiveTimers.set(fp, inactiveTimer);
    }, this.getTiming().resolutionDelayMs);
    this.resolutionTimers.set(fp, timer);
  }

  private clearPendingTimer(fp: string): void {
    const t = this.pendingTimers.get(fp);
    if (t) { clearTimeout(t); this.pendingTimers.delete(fp); }
  }

  private clearResolutionTimer(fp: string): void {
    const t = this.resolutionTimers.get(fp);
    if (t) { clearTimeout(t); this.resolutionTimers.delete(fp); }
  }

  private isInCooldown(inst: AlertInstance): boolean {
    if (!inst.lastNotifiedAt) return false;
    const elapsed = Date.now() - inst.lastNotifiedAt;
    const cooldown = inst.severity === 'critical'
      ? this.getTiming().cooldownCriticalMs
      : this.getTiming().cooldownWarningMs;
    return elapsed < cooldown;
  }

  private shouldRepeat(inst: AlertInstance): boolean {
    if (!inst.lastNotifiedAt) return true;
    const elapsed = Date.now() - inst.lastNotifiedAt;
    const interval = inst.severity === 'critical'
      ? this.getTiming().repeatCriticalMs
      : this.getTiming().repeatWarningMs;
    return elapsed >= interval;
  }

  private maybeRepeatNotify(event: AlertEvent, inst: AlertInstance): void {
    if (this.shouldRepeat(inst)) {
      this.notifyFiring(event, inst);
    }
  }

  private async notifyFiring(event: AlertEvent, inst: AlertInstance): Promise<void> {
    if (!this.enabled) return;
    if (!this.isEventEnabled(event.type)) return;
    if (this.isInCooldown(inst)) return;

    inst.lastNotifiedAt = Date.now();
    const duration = inst.firedAt ? Date.now() - inst.firedAt : 0;
    log.warn({ type: event.type, severity: event.severity, fingerprint: event.fingerprint, duration }, `Alert FIRING: ${event.title}`);

    const allowedChannels = this.getDeliveryChannelNames(event.type);
    for (const channel of this.channels) {
      if (allowedChannels && !allowedChannels.includes(channel.name)) continue;
      if (!this.isChannelEnabled(channel.name)) continue;
      if (this.isCircularDelivery(event, channel.name)) continue;

      try {
        await channel.send(event, inst, 'firing');
      } catch (e) {
        log.error({ channel: channel.name, err: e instanceof Error ? e.message : String(e) }, 'Alert delivery failed');
      }
    }

    this.persistAlert(inst, 'firing').catch(() => {});
  }

  private async notifyResolved(inst: AlertInstance): Promise<void> {
    if (!this.enabled) return;
    if (!this.isEventEnabled(inst.type)) return;

    const duration = inst.firedAt && inst.resolvedAt ? inst.resolvedAt - inst.firedAt : 0;
    const durationStr = formatDuration(duration);
    log.info({ type: inst.type, fingerprint: inst.fingerprint, durationMs: duration }, `Alert RESOLVED: ${inst.title} (after ${durationStr})`);

    const event: AlertEvent = {
      type: inst.type,
      severity: inst.severity,
      source: inst.labels['source'] ?? 'unknown',
      fingerprint: inst.fingerprint,
      labels: inst.labels,
      title: inst.title,
      message: `Resolved after ${durationStr}`,
      timestamp: Date.now(),
    };

    const allowedChannels = this.getDeliveryChannelNames(inst.type);
    for (const channel of this.channels) {
      if (allowedChannels && !allowedChannels.includes(channel.name)) continue;
      if (!this.isChannelEnabled(channel.name)) continue;

      try {
        await channel.send(event, inst, 'resolved');
      } catch (e) {
        log.error({ channel: channel.name, err: e instanceof Error ? e.message : String(e) }, 'Alert recovery delivery failed');
      }
    }

    this.persistAlert(inst, 'resolved').catch(() => {});
  }

  private isChannelEnabled(channelName: string): boolean {
    const d = this.config.delivery;
    switch (channelName) {
      case 'telegram': return d.telegram.enabled;
      case 'whatsapp': return d.whatsapp.enabled;
      case 'websocket': return d.websocket.enabled;
      case 'webhook': return d.webhook.enabled;
      default: return true;
    }
  }

  private isCircularDelivery(event: AlertEvent, channelName: string): boolean {
    if (event.type === ALERT_TYPES.CHANNEL_DISCONNECTED || event.type === ALERT_TYPES.CHANNEL_AUTH_LOST) {
      return event.labels['channel'] === channelName;
    }
    return false;
  }

  private async persistAlert(inst: AlertInstance, state: string): Promise<void> {
    if (!this.db) return;
    try {
      const id = `${inst.fingerprint}-${Date.now()}`;
      await this.db.run(
        `INSERT INTO alert_history (id, fingerprint, type, severity, state, title, message, labels, fired_at, resolved_at, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, inst.fingerprint, inst.type, inst.severity, state,
          inst.title, inst.message, JSON.stringify(inst.labels),
          inst.firedAt ? new Date(inst.firedAt).toISOString() : null,
          inst.resolvedAt ? new Date(inst.resolvedAt).toISOString() : null,
          inst.firedAt && inst.resolvedAt ? inst.resolvedAt - inst.firedAt : null,
          new Date().toISOString(),
        ],
      );
    } catch (e) {
      log.error({ err: e instanceof Error ? e.message : String(e) }, 'Failed to persist alert history');
    }
  }
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
