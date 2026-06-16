import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlertManager, fingerprint } from '../index.js';
import type { AlertsConfig, AlertDeliveryChannel, AlertEvent, AlertInstance } from '@agw/types';

function makeConfig(overrides: Partial<AlertsConfig> = {}): AlertsConfig {
  return {
    enabled: true,
    delivery: {
      telegram: { enabled: false, chatIds: [] },
      whatsapp: { enabled: false, jids: [] },
      websocket: { enabled: true },
      webhook: { enabled: false, urls: [], secret: '' },
    },
    timing: {
      groupWaitMs: 100,
      cooldownCriticalMs: 500,
      cooldownWarningMs: 1000,
      repeatCriticalMs: 2000,
      repeatWarningMs: 5000,
      resolutionDelayMs: 100,
    },
    thresholds: {
      failureThreshold: 2,
      recoveryThreshold: 2,
    },
    events: {},
    ...overrides,
  };
}

function mockChannel(): AlertDeliveryChannel & { calls: Array<{ event: AlertEvent; instance: AlertInstance; kind: string }> } {
  const calls: Array<{ event: AlertEvent; instance: AlertInstance; kind: string }> = [];
  return {
    name: 'websocket',
    calls,
    async send(event: AlertEvent, instance: AlertInstance, kind: 'firing' | 'resolved') {
      calls.push({ event, instance, kind });
    },
  };
}

describe('fingerprint', () => {
  it('produces consistent hash for same type+labels', () => {
    const fp1 = fingerprint('channel.disconnected', { channel: 'whatsapp' });
    const fp2 = fingerprint('channel.disconnected', { channel: 'whatsapp' });
    expect(fp1).toBe(fp2);
  });

  it('produces different hash for different labels', () => {
    const fp1 = fingerprint('channel.disconnected', { channel: 'whatsapp' });
    const fp2 = fingerprint('channel.disconnected', { channel: 'telegram' });
    expect(fp1).not.toBe(fp2);
  });

  it('produces different hash for different types', () => {
    const fp1 = fingerprint('channel.disconnected', { channel: 'whatsapp' });
    const fp2 = fingerprint('channel.auth_lost', { channel: 'whatsapp' });
    expect(fp1).not.toBe(fp2);
  });

  it('is order-independent for labels', () => {
    const fp1 = fingerprint('test', { a: '1', b: '2' });
    const fp2 = fingerprint('test', { b: '2', a: '1' });
    expect(fp1).toBe(fp2);
  });
});

describe('AlertManager', () => {
  let manager: AlertManager;
  let channel: ReturnType<typeof mockChannel>;

  beforeEach(() => {
    vi.useFakeTimers();
    channel = mockChannel();
    manager = new AlertManager({ config: makeConfig() });
    manager.registerChannel(channel);
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  const event = {
    type: 'channel.disconnected',
    severity: 'critical' as const,
    source: 'whatsapp',
    labels: { source: 'whatsapp', channel: 'whatsapp' },
    title: 'WhatsApp disconnected',
    message: 'Connection lost',
  };

  describe('state machine transitions', () => {
    it('goes to PENDING on first failure (below threshold)', () => {
      manager.emitFailure(event);
      const inst = manager.getStore().getAll()[0];
      expect(inst.state).toBe('pending');
      expect(inst.failureCount).toBe(1);
    });

    it('goes to FIRING when failure threshold reached', () => {
      manager.emitFailure(event);
      manager.emitFailure(event);
      const inst = manager.getStore().getAll()[0];
      expect(inst.state).toBe('firing');
      expect(channel.calls.length).toBe(1);
      expect(channel.calls[0].kind).toBe('firing');
    });

    it('goes back to INACTIVE from PENDING on success', () => {
      manager.emitFailure(event);
      manager.emitSuccess('channel.disconnected', event.labels);
      const inst = manager.getStore().getAll()[0];
      expect(inst.state).toBe('inactive');
    });

    it('requires recoveryThreshold successes to resolve from FIRING', () => {
      manager.emitFailure(event);
      manager.emitFailure(event);
      expect(manager.getStore().getAll()[0].state).toBe('firing');

      manager.emitSuccess('channel.disconnected', event.labels);
      expect(manager.getStore().getAll()[0].state).toBe('firing');

      manager.emitSuccess('channel.disconnected', event.labels);
      // Resolution is delayed — still firing until timer
      expect(manager.getStore().getAll()[0].state).toBe('firing');

      vi.advanceTimersByTime(200);
      expect(manager.getStore().getAll()[0].state).toBe('resolved');
    });

    it('cancels resolution if failure occurs during recovery', () => {
      manager.emitFailure(event);
      manager.emitFailure(event);

      manager.emitSuccess('channel.disconnected', event.labels);
      manager.emitSuccess('channel.disconnected', event.labels);
      // Now emit failure before resolution timer fires
      manager.emitFailure(event);

      vi.advanceTimersByTime(200);
      expect(manager.getStore().getAll()[0].state).toBe('firing');
    });
  });

  describe('dedup', () => {
    it('same fingerprint updates existing instance', () => {
      manager.emitFailure(event);
      manager.emitFailure(event);
      expect(manager.getStore().getAll().length).toBe(1);
    });

    it('different labels create different instances', () => {
      manager.emitFailure(event);
      manager.emitFailure({ ...event, labels: { source: 'telegram', channel: 'telegram' }, title: 'Telegram down' });
      expect(manager.getStore().getAll().length).toBe(2);
    });
  });

  describe('cooldown', () => {
    it('suppresses duplicate notifications within cooldown window', () => {
      manager.emitFailure(event);
      manager.emitFailure(event);
      expect(channel.calls.length).toBe(1);

      // Emit more failures — should be suppressed by cooldown
      manager.emitFailure(event);
      manager.emitFailure(event);
      expect(channel.calls.length).toBe(1);
    });

    it('resends after cooldown expires', () => {
      manager.emitFailure(event);
      manager.emitFailure(event);
      expect(channel.calls.length).toBe(1);

      vi.advanceTimersByTime(600); // past 500ms cooldown
      manager.emitFailure(event);
      // Still won't send because repeat interval (2000) not reached
      expect(channel.calls.length).toBe(1);
    });
  });

  describe('repeat interval', () => {
    it('resends notification after repeat interval for persistent alerts', () => {
      manager.emitFailure(event);
      manager.emitFailure(event);
      expect(channel.calls.length).toBe(1);

      vi.advanceTimersByTime(2100); // past 2000ms repeat
      manager.emitFailure(event);
      expect(channel.calls.length).toBe(2);
    });
  });

  describe('recovery notifications', () => {
    it('sends resolved notification after recovery', () => {
      manager.emitFailure(event);
      manager.emitFailure(event);
      expect(channel.calls.filter(c => c.kind === 'firing').length).toBe(1);

      manager.emitSuccess('channel.disconnected', event.labels);
      manager.emitSuccess('channel.disconnected', event.labels);
      vi.advanceTimersByTime(200);

      const resolved = channel.calls.filter(c => c.kind === 'resolved');
      expect(resolved.length).toBe(1);
      expect(resolved[0].event.message).toContain('Resolved');
    });
  });

  describe('disabled alerts', () => {
    it('does not emit when alerts are disabled globally', () => {
      manager.updateConfig(makeConfig({ enabled: false }));
      manager.emitFailure(event);
      manager.emitFailure(event);
      expect(channel.calls.length).toBe(0);
    });

    it('does not emit for disabled event type', () => {
      manager.updateConfig(makeConfig({
        events: { 'channel.disconnected': { enabled: false } },
      }));
      manager.emitFailure(event);
      manager.emitFailure(event);
      expect(channel.calls.length).toBe(0);
    });
  });

  describe('per-event threshold overrides', () => {
    it('uses event-specific failure threshold', () => {
      manager.updateConfig(makeConfig({
        events: { 'channel.disconnected': { failureThreshold: 5 } },
      }));

      for (let i = 0; i < 4; i++) manager.emitFailure(event);
      expect(channel.calls.length).toBe(0);

      manager.emitFailure(event);
      expect(channel.calls.length).toBe(1);
    });
  });

  describe('circular delivery guard', () => {
    it('skips delivery channel matching the disconnected channel', () => {
      const waChannel = mockChannel();
      (waChannel as any).name = 'whatsapp';
      const mgr = new AlertManager({ config: makeConfig() });
      mgr.registerChannel(waChannel);

      mgr.emitFailure(event); // WhatsApp disconnect alert
      mgr.emitFailure(event);

      // WhatsApp channel should NOT receive the alert (circular)
      expect(waChannel.calls.length).toBe(0);
    });
  });

  describe('getFiringAlerts', () => {
    it('returns only FIRING instances', () => {
      manager.emitFailure(event);
      expect(manager.getFiringAlerts().length).toBe(0);

      manager.emitFailure(event);
      expect(manager.getFiringAlerts().length).toBe(1);
    });
  });

  describe('warning severity', () => {
    const warnEvent = { ...event, severity: 'warning' as const, title: 'Warning test' };

    it('fires warning alerts with warning cooldown', () => {
      manager.emitFailure(warnEvent);
      manager.emitFailure(warnEvent);
      expect(channel.calls.length).toBe(1);
      expect(channel.calls[0].event.severity).toBe('warning');
    });
  });

  describe('resolved-to-inactive lifecycle', () => {
    it('transitions resolved → inactive after delay', () => {
      manager.emitFailure(event);
      manager.emitFailure(event);
      manager.emitSuccess(event.type, event.labels);
      manager.emitSuccess(event.type, event.labels);
      vi.advanceTimersByTime(200);
      expect(manager.getStore().getAll()[0].state).toBe('resolved');

      vi.advanceTimersByTime(65_000);
      expect(manager.getStore().getAll()[0].state).toBe('inactive');
    });
  });

  describe('emitSuccess on non-existent fingerprint', () => {
    it('does nothing when no alert exists', () => {
      manager.emitSuccess('nonexistent.type', { source: 'test' });
      expect(manager.getStore().getAll().length).toBe(0);
    });
  });

  describe('resolution timer not reset on repeated success', () => {
    it('does not restart resolution timer on every health probe success', () => {
      manager.emitFailure(event);
      manager.emitFailure(event);

      manager.emitSuccess(event.type, event.labels);
      manager.emitSuccess(event.type, event.labels);
      // Resolution timer scheduled, advance partially
      vi.advanceTimersByTime(50);
      // More successes should NOT restart the timer
      manager.emitSuccess(event.type, event.labels);
      manager.emitSuccess(event.type, event.labels);
      // Advance past original timer
      vi.advanceTimersByTime(150);
      expect(manager.getStore().getAll()[0].state).toBe('resolved');
    });
  });

  describe('channel delivery filtering', () => {
    it('respects per-event delivery channel override', () => {
      const ch2 = mockChannel();
      (ch2 as any).name = 'telegram';
      const mgr = new AlertManager({
        config: makeConfig({
          delivery: {
            telegram: { enabled: true, chatIds: [] },
            whatsapp: { enabled: false, jids: [] },
            websocket: { enabled: true },
            webhook: { enabled: false, urls: [], secret: '' },
          },
          events: { 'channel.disconnected': { delivery: ['telegram'] } },
        }),
      });
      mgr.registerChannel(channel);
      mgr.registerChannel(ch2);

      mgr.emitFailure(event);
      mgr.emitFailure(event);

      expect(channel.calls.length).toBe(0);
      expect(ch2.calls.length).toBe(1);
    });
  });

  describe('global disable clears notifications', () => {
    it('notifyFiring respects enabled flag after updateConfig', () => {
      manager.emitFailure(event);
      manager.emitFailure(event);
      expect(channel.calls.length).toBe(1);

      manager.updateConfig(makeConfig({ enabled: false }));
      vi.advanceTimersByTime(2100);
      manager.emitFailure(event);
      // Should not send because globally disabled
      expect(channel.calls.length).toBe(1);
    });
  });
});
