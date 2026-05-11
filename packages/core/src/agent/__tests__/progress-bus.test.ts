/**
 * Tests for the per-session pub/sub bus that backs the SSE progress
 * stream. Covers the lifecycle invariants the registry and route
 * code depend on.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ProgressBus, type ProgressEvent } from '@agw/tool-platform';

let bus: ProgressBus;

function event(sessionId: string, kind: string, extra: Partial<ProgressEvent> = {}): ProgressEvent {
  return { sessionId, kind, timestamp: Date.now(), ...extra };
}

beforeEach(() => {
  bus = new ProgressBus();
});

describe('subscribe / unsubscribe lifecycle', () => {
  it('delivers events to a subscribed session', () => {
    const received: ProgressEvent[] = [];
    bus.subscribe('s1', e => received.push(e));
    bus.emit(event('s1', 'tool.start', { toolName: 'exec' }));
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe('tool.start');
  });

  it('does not deliver events from other sessions', () => {
    const received: ProgressEvent[] = [];
    bus.subscribe('s1', e => received.push(e));
    bus.emit(event('s2', 'tool.start'));
    expect(received).toHaveLength(0);
  });

  it('unsubscribe stops further events for that subscriber', () => {
    const received: ProgressEvent[] = [];
    const off = bus.subscribe('s1', e => received.push(e));
    bus.emit(event('s1', 'tool.start'));
    off();
    bus.emit(event('s1', 'tool.complete'));
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe('tool.start');
  });

  it('drops the per-session bucket when its last subscriber unsubscribes', () => {
    const off = bus.subscribe('s1', () => {});
    expect(bus.activeSessionCount).toBe(1);
    off();
    expect(bus.activeSessionCount).toBe(0);
  });

  it('keeps the bucket alive while at least one subscriber remains', () => {
    const offA = bus.subscribe('s1', () => {});
    const offB = bus.subscribe('s1', () => {});
    offA();
    expect(bus.subscriberCount('s1')).toBe(1);
    offB();
    expect(bus.subscriberCount('s1')).toBe(0);
  });

  it('swallows subscriber errors so one bad client cannot break others', () => {
    const ok: ProgressEvent[] = [];
    bus.subscribe('s1', () => { throw new Error('boom'); });
    bus.subscribe('s1', e => ok.push(e));
    bus.emit(event('s1', 'tool.start'));
    expect(ok).toHaveLength(1);
  });
});

describe('wildcard subscription', () => {
  it('receives events from every session', () => {
    const received: ProgressEvent[] = [];
    bus.subscribeAll(e => received.push(e));
    bus.emit(event('s1', 'tool.start'));
    bus.emit(event('s2', 'tool.complete'));
    bus.emit(event('s3', 'tool.error'));
    expect(received.map(e => e.sessionId)).toEqual(['s1', 's2', 's3']);
  });

  it('still fires when no per-session subscribers exist', () => {
    const received: ProgressEvent[] = [];
    bus.subscribeAll(e => received.push(e));
    bus.emit(event('orphan', 'tool.start'));
    expect(received).toHaveLength(1);
  });

  it('unsubscribe stops wildcard delivery', () => {
    const received: ProgressEvent[] = [];
    const off = bus.subscribeAll(e => received.push(e));
    bus.emit(event('s1', 'tool.start'));
    off();
    bus.emit(event('s1', 'tool.complete'));
    expect(received).toHaveLength(1);
  });
});

describe('history ring buffer / replay', () => {
  it('replays buffered events to a brand-new subscriber via getHistory', () => {
    bus.emit(event('s1', 'tool.start', { toolName: 'a' }));
    bus.emit(event('s1', 'tool.complete', { toolName: 'a' }));
    bus.emit(event('s2', 'tool.start', { toolName: 'b' }));

    const s1History = bus.getHistory('s1');
    expect(s1History.map(e => e.kind)).toEqual(['tool.start', 'tool.complete']);
    expect(bus.getHistory()).toHaveLength(3);
  });

  it('caps the buffer at 200 events and drops the oldest first', () => {
    for (let i = 0; i < 250; i++) {
      bus.emit(event('s1', `evt.${i}`));
    }
    const all = bus.getHistory();
    expect(all).toHaveLength(200);
    // Oldest should be evt.50 (250 - 200), newest evt.249
    expect(all[0].kind).toBe('evt.50');
    expect(all[all.length - 1].kind).toBe('evt.249');
  });

  it('totalEventsEmitted counts every emit even when history is full', () => {
    for (let i = 0; i < 250; i++) bus.emit(event('s1', `evt.${i}`));
    expect(bus.totalEventsEmitted).toBe(250);
  });
});

describe('clearSession', () => {
  it('drops per-session subscribers and history events for that session only', () => {
    const s1Recv: ProgressEvent[] = [];
    const s2Recv: ProgressEvent[] = [];
    bus.subscribe('s1', e => s1Recv.push(e));
    bus.subscribe('s2', e => s2Recv.push(e));
    bus.emit(event('s1', 'tool.start'));
    bus.emit(event('s2', 'tool.start'));

    const dropped = bus.clearSession('s1');
    expect(dropped).toBe(1);
    // s1 bucket gone, s2 bucket intact
    expect(bus.subscriberCount('s1')).toBe(0);
    expect(bus.subscriberCount('s2')).toBe(1);
    // History no longer carries s1 events, but keeps s2 events
    const remaining = bus.getHistory();
    expect(remaining.every(e => e.sessionId !== 's1')).toBe(true);
    expect(remaining.some(e => e.sessionId === 's2')).toBe(true);
  });

  it('returns 0 and is a no-op for an unknown session', () => {
    bus.emit(event('s1', 'tool.start'));
    const dropped = bus.clearSession('does-not-exist');
    expect(dropped).toBe(0);
    // s1 history must remain untouched
    expect(bus.getHistory('s1')).toHaveLength(1);
  });

  it('after clearSession, new emits for the same session id are still delivered (only state was reset)', () => {
    bus.subscribe('s1', () => {});
    bus.emit(event('s1', 'tool.start'));
    bus.clearSession('s1');
    // Re-subscribe and emit — should work as if it were a fresh session
    const received: ProgressEvent[] = [];
    bus.subscribe('s1', e => received.push(e));
    bus.emit(event('s1', 'tool.complete'));
    expect(received).toHaveLength(1);
  });
});
