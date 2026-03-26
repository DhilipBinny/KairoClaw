/**
 * Per-session serialization queue with global concurrency cap.
 *
 * Ensures only one agent run at a time per session key, while allowing
 * up to `maxConcurrent` total agent runs across all sessions.
 *
 * Uses a proper semaphore pattern (no busy-wait polling).
 */

export class AgentQueue {
  private readonly maxConcurrent: number;
  private running: number;
  private readonly sessionQueues: Map<string, Promise<unknown>>;
  private readonly waiters: Array<() => void>;

  constructor(maxConcurrent = 4) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.sessionQueues = new Map();
    this.waiters = [];
  }

  /**
   * Enqueue a task for the given session key.
   * Tasks for the same session run serially; tasks for different
   * sessions run concurrently up to the global cap.
   */
  async enqueue<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    // Chain onto the existing session promise (or start fresh)
    const prev = this.sessionQueues.get(sessionKey) ?? Promise.resolve();

    const next = prev.then(async () => {
      // Wait for a global concurrency slot (semaphore acquire)
      await this.acquire();
      try {
        return await task();
      } finally {
        this.release();
      }
    });

    // Prevent unhandled rejection on the chain — log for observability
    next.catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg) console.error(`[AgentQueue] Task failed for session "${sessionKey}": ${msg}`);
    });
    this.sessionQueues.set(sessionKey, next);

    // Clean up completed session chains to prevent memory leak
    next.finally(() => {
      if (this.sessionQueues.get(sessionKey) === next) {
        this.sessionQueues.delete(sessionKey);
      }
    });

    return next as Promise<T>;
  }

  /** Acquire a concurrency slot, waiting if necessary. */
  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  /** Release a concurrency slot and wake the next waiter if any. */
  private release(): void {
    this.running--;
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }

  /** Current queue statistics. */
  get stats(): { running: number; maxConcurrent: number; sessions: number } {
    return {
      running: this.running,
      maxConcurrent: this.maxConcurrent,
      sessions: this.sessionQueues.size,
    };
  }
}
