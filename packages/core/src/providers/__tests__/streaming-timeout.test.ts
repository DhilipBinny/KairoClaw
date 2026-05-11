import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStreamingTimeout } from '@agw/provider-bridge';

describe('createStreamingTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts after TTFT if no activity', () => {
    vi.useFakeTimers();
    const st = createStreamingTimeout({ ttftMs: 100, idleMs: 500 });
    expect(st.signal.aborted).toBe(false);

    vi.advanceTimersByTime(99);
    expect(st.signal.aborted).toBe(false);

    vi.advanceTimersByTime(2);
    expect(st.signal.aborted).toBe(true);
    st.clear();
  });

  it('switches to idle timer after first activity', () => {
    vi.useFakeTimers();
    const st = createStreamingTimeout({ ttftMs: 100, idleMs: 200 });

    vi.advanceTimersByTime(50);
    st.onActivity(); // first chunk at 50ms — switches to idle timer

    vi.advanceTimersByTime(199);
    expect(st.signal.aborted).toBe(false); // idle not expired yet

    vi.advanceTimersByTime(2);
    expect(st.signal.aborted).toBe(true); // idle expired
    st.clear();
  });

  it('resets idle timer on each activity', () => {
    vi.useFakeTimers();
    const st = createStreamingTimeout({ ttftMs: 100, idleMs: 200 });

    st.onActivity(); // t=0
    vi.advanceTimersByTime(150);
    st.onActivity(); // t=150 — resets idle to 200ms from now

    vi.advanceTimersByTime(150);
    st.onActivity(); // t=300 — resets again

    vi.advanceTimersByTime(150);
    expect(st.signal.aborted).toBe(false); // t=450, last activity at t=300, idle=200 → expires at t=500

    vi.advanceTimersByTime(51);
    expect(st.signal.aborted).toBe(true); // t=501, expired
    st.clear();
  });

  it('clear prevents abort', () => {
    vi.useFakeTimers();
    const st = createStreamingTimeout({ ttftMs: 50, idleMs: 100 });

    vi.advanceTimersByTime(30);
    st.clear();

    vi.advanceTimersByTime(200);
    expect(st.signal.aborted).toBe(false);
  });

  it('composes with external signal', () => {
    const external = new AbortController();
    const st = createStreamingTimeout({ ttftMs: 5000, idleMs: 5000, signal: external.signal });

    expect(st.signal.aborted).toBe(false);
    external.abort();
    expect(st.signal.aborted).toBe(true);
    st.clear();
  });
});
