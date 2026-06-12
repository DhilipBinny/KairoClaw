import { describe, it, expect } from 'vitest';
import { createStreamingTimeout } from '../streaming-timeout.js';

describe('createStreamingTimeout — caller cancellation (#181)', () => {
  it('aborts immediately when the caller signal is ALREADY aborted', () => {
    // addEventListener('abort', ...) never fires for an already-aborted signal,
    // which previously let a cancelled request (or a failover carrying the same
    // signal) run to completion. The composed signal must be aborted upfront.
    const ac = new AbortController();
    ac.abort();
    const st = createStreamingTimeout({ signal: ac.signal });
    expect(st.signal.aborted).toBe(true);
    st.clear();
  });

  it('propagates a later abort of the caller signal', () => {
    const ac = new AbortController();
    const st = createStreamingTimeout({ signal: ac.signal, ttftMs: 60_000, idleMs: 60_000 });
    expect(st.signal.aborted).toBe(false);
    ac.abort();
    expect(st.signal.aborted).toBe(true);
    st.clear();
  });
});
