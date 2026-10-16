import { describe, it, expect } from 'vitest';
import { getTraceId, withTraceId, withTraceIdAsync } from '../trace.js';

describe('trace context', () => {
  it('returns undefined when no trace context is active', () => {
    expect(getTraceId()).toBeUndefined();
  });

  it('provides a trace ID inside withTraceId', () => {
    withTraceId(() => {
      const id = getTraceId();
      expect(id).toBeDefined();
      expect(id).toMatch(/^tr-[a-f0-9]{12}$/);
    });
  });

  it('returns undefined after withTraceId exits', () => {
    withTraceId(() => {
      expect(getTraceId()).toBeDefined();
    });
    expect(getTraceId()).toBeUndefined();
  });

  it('uses a custom trace ID when provided', () => {
    withTraceId(() => {
      expect(getTraceId()).toBe('custom-123');
    }, 'custom-123');
  });

  it('provides trace ID inside withTraceIdAsync', async () => {
    await withTraceIdAsync(async () => {
      const id = getTraceId();
      expect(id).toBeDefined();
      expect(id).toMatch(/^tr-[a-f0-9]{12}$/);
    });
  });

  it('preserves trace ID across async boundaries', async () => {
    await withTraceIdAsync(async () => {
      const before = getTraceId();
      await new Promise((r) => setTimeout(r, 10));
      const after = getTraceId();
      expect(before).toBe(after);
    });
  });

  it('isolates trace IDs between concurrent contexts', async () => {
    const ids: string[] = [];
    await Promise.all([
      withTraceIdAsync(async () => {
        await new Promise((r) => setTimeout(r, 5));
        ids.push(getTraceId()!);
      }, 'ctx-a'),
      withTraceIdAsync(async () => {
        await new Promise((r) => setTimeout(r, 5));
        ids.push(getTraceId()!);
      }, 'ctx-b'),
    ]);
    expect(ids).toContain('ctx-a');
    expect(ids).toContain('ctx-b');
  });

  it('supports nested contexts without leaking', () => {
    withTraceId(() => {
      const outer = getTraceId();
      withTraceId(() => {
        const inner = getTraceId();
        expect(inner).not.toBe(outer);
      });
      expect(getTraceId()).toBe(outer);
    });
  });
});
