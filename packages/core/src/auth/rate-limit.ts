/**
 * Small in-memory windowed rate limiter, keyed by an arbitrary string (e.g. a
 * client IP). Used for brute-force protection on authentication.
 *
 * It is intentionally simple and process-local. Behind a reverse proxy, set
 * gateway.trustProxy so request.ip reflects the real client (otherwise every
 * client shares the proxy's IP and therefore one bucket).
 */
import { LOGIN_MAP_MAX_SIZE } from '../constants.js';

interface Entry { count: number; resetAt: number }

export class RateLimiter {
  private map = new Map<string, Entry>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys: number = LOGIN_MAP_MAX_SIZE,
  ) {}

  /** True if `key` is currently at/over the limit (does not record an attempt). */
  isLimited(key: string, now: number = Date.now()): boolean {
    const e = this.map.get(key);
    if (!e || now > e.resetAt) return false;
    return e.count >= this.max;
  }

  /**
   * Record one attempt for `key` and return false if it is now over the limit.
   * Bounds memory at maxKeys: when full, evicts expired entries first, then the
   * oldest entry — so a flood of unique keys can't stop new offenders from being
   * tracked (and can't deny new legitimate clients either).
   */
  record(key: string, now: number = Date.now()): boolean {
    const existing = this.map.get(key);
    if (existing && now <= existing.resetAt) {
      existing.count++;
      return existing.count <= this.max;
    }

    // New (or expired) key — ensure there is room before (re)inserting.
    if (!this.map.has(key) && this.map.size >= this.maxKeys) {
      for (const [k, e] of this.map) if (now > e.resetAt) this.map.delete(k);
      while (this.map.size >= this.maxKeys) {
        const oldest = this.map.keys().next().value;
        if (oldest === undefined) break;
        this.map.delete(oldest);
      }
    }
    this.map.set(key, { count: 1, resetAt: now + this.windowMs });
    return true;
  }

  /** Clear a key's attempts (e.g. after a successful auth). */
  reset(key: string): void {
    this.map.delete(key);
  }

  /** Start periodic eviction of expired entries. */
  startCleanup(intervalMs = 5 * 60_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [k, e] of this.map) if (now > e.resetAt) this.map.delete(k);
    }, intervalMs);
    this.cleanupTimer.unref?.();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = undefined; }
  }
}
