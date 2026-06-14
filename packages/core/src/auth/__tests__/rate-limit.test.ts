import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../rate-limit.js';

describe('RateLimiter', () => {
  it('allows up to max then blocks within the window', () => {
    const rl = new RateLimiter(3, 1000);
    expect(rl.record('ip', 0)).toBe(true);
    expect(rl.record('ip', 0)).toBe(true);
    expect(rl.record('ip', 0)).toBe(true);
    expect(rl.record('ip', 0)).toBe(false); // 4th over limit
    expect(rl.isLimited('ip', 0)).toBe(true);
  });

  it('isLimited does not itself count an attempt', () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.isLimited('ip', 0)).toBe(false);
    expect(rl.isLimited('ip', 0)).toBe(false);
    expect(rl.record('ip', 0)).toBe(true);
    expect(rl.isLimited('ip', 0)).toBe(true);
  });

  it('resets after the window elapses', () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.record('ip', 0)).toBe(true);
    expect(rl.record('ip', 500)).toBe(false);
    expect(rl.record('ip', 1500)).toBe(true); // new window
  });

  it('reset() clears a key', () => {
    const rl = new RateLimiter(1, 1000);
    rl.record('ip', 0);
    expect(rl.isLimited('ip', 0)).toBe(true);
    rl.reset('ip');
    expect(rl.isLimited('ip', 0)).toBe(false);
  });

  it('keys are independent', () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.record('a', 0)).toBe(true);
    expect(rl.record('a', 0)).toBe(false);
    expect(rl.record('b', 0)).toBe(true);
  });

  it('evicts the oldest key when the map is full, keeping new keys tracked + memory bounded', () => {
    const rl = new RateLimiter(1, 1000, 2);
    expect(rl.record('a', 0)).toBe(true);
    expect(rl.record('a', 0)).toBe(false); // a now at limit
    expect(rl.record('b', 0)).toBe(true);  // map full {a,b}
    // c is new and map is full → evict oldest (a), admit c.
    expect(rl.record('c', 0)).toBe(true);
    expect(rl.isLimited('b', 0)).toBe(true);  // b (newer) still tracked + limited
    expect(rl.isLimited('a', 0)).toBe(false); // a was evicted
  });
});
