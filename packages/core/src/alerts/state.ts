import type { AlertInstance, AlertSeverity, AlertState } from '@agw/types';
import { ALERT_MAX_INSTANCES } from '../constants.js';

/**
 * In-memory store for alert instances, keyed by fingerprint.
 * No persistence needed — rate limit windows are short and state
 * self-corrects from health probes within one interval after restart.
 */
export class AlertStateStore {
  private instances = new Map<string, AlertInstance>();

  get(fingerprint: string): AlertInstance | undefined {
    return this.instances.get(fingerprint);
  }

  getOrCreate(fingerprint: string, type: string, severity: AlertSeverity, labels: Record<string, string>, title: string, message: string): AlertInstance {
    let inst = this.instances.get(fingerprint);
    if (!inst) {
      if (this.instances.size >= ALERT_MAX_INSTANCES) {
        this.evictOldest();
      }
      inst = {
        fingerprint,
        type,
        severity,
        state: 'inactive',
        labels,
        title,
        message,
        failureCount: 0,
        successCount: 0,
        pendingSince: null,
        firedAt: null,
        resolvedAt: null,
        lastNotifiedAt: null,
        lastEventAt: Date.now(),
      };
      this.instances.set(fingerprint, inst);
    }
    return inst;
  }

  getAll(): AlertInstance[] {
    return [...this.instances.values()];
  }

  getFiring(): AlertInstance[] {
    return this.getAll().filter(i => i.state === 'firing');
  }

  delete(fingerprint: string): void {
    this.instances.delete(fingerprint);
  }

  private evictOldest(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    const evictable: Array<'inactive' | 'resolved' | 'pending'> = ['inactive', 'resolved', 'pending'];
    for (const targetState of evictable) {
      for (const [fp, inst] of this.instances) {
        if (inst.state === targetState && inst.lastEventAt < oldestTime) {
          oldestTime = inst.lastEventAt;
          oldest = fp;
        }
      }
      if (oldest) break;
    }
    if (oldest) {
      this.instances.delete(oldest);
    }
  }

  transition(fingerprint: string, newState: AlertState): void {
    const inst = this.instances.get(fingerprint);
    if (!inst) return;
    inst.state = newState;
    inst.lastEventAt = Date.now();

    if (newState === 'pending' && !inst.pendingSince) {
      inst.pendingSince = Date.now();
    }
    if (newState === 'firing') {
      inst.firedAt = Date.now();
      inst.pendingSince = null;
    }
    if (newState === 'resolved') {
      inst.resolvedAt = Date.now();
    }
    if (newState === 'inactive') {
      inst.pendingSince = null;
      inst.firedAt = null;
      inst.resolvedAt = null;
      inst.failureCount = 0;
      inst.successCount = 0;
      inst.lastNotifiedAt = null;
    }
  }
}
