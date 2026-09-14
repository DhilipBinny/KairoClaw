import { describe, it, expect } from 'vitest';
import { isSessionExpired } from '../session-lifecycle.js';
import type { SessionRow } from '../../db/repositories/session.js';

// Use a resetHour far ahead of "now" so the daily reset boundary never
// interferes with idle-only tests. Adding 12 hours ensures that any
// session from minutesAgo(N) or hoursAgo(N) is always AFTER the most
// recent reset boundary, so only the idle check determines expiry.
const SAFE_RESET_HOUR = (new Date().getHours() + 12) % 24;
const IDLE_ONLY_CONFIG = { resetHour: SAFE_RESET_HOUR, idleMinutes: 60 };
const IDLE_DISABLED_CONFIG = { resetHour: SAFE_RESET_HOUR, idleMinutes: 0 };

function makeSession(updatedAt: string): SessionRow {
  return {
    id: 'test-session',
    tenant_id: 'default',
    user_id: null,
    channel: 'telegram',
    chat_id: 'telegram:123',
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    turns: 5,
    metadata: '{}',
    created_at: updatedAt,
    updated_at: updatedAt,
    expires_at: null,
  };
}

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 60_000).toISOString();
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60_000).toISOString();
}

describe('isSessionExpired', () => {
  describe('idle timeout', () => {
    it('returns false when idleMinutes is 0 (disabled)', () => {
      expect(isSessionExpired(
        makeSession(minutesAgo(5)),
        IDLE_DISABLED_CONFIG,
      )).toBe(false);
    });

    it('returns true when idle longer than idleMinutes', () => {
      expect(isSessionExpired(
        makeSession(hoursAgo(2)),
        IDLE_ONLY_CONFIG,
      )).toBe(true);
    });

    it('returns false when within idle window', () => {
      expect(isSessionExpired(
        makeSession(minutesAgo(5)),
        IDLE_ONLY_CONFIG,
      )).toBe(false);
    });

    it('returns true just past the boundary', () => {
      const justPast = new Date(Date.now() - 60 * 60_000 - 1000).toISOString();
      expect(isSessionExpired(
        makeSession(justPast),
        IDLE_ONLY_CONFIG,
      )).toBe(true);
    });

    it('returns false well before the boundary', () => {
      expect(isSessionExpired(
        makeSession(minutesAgo(30)),
        IDLE_ONLY_CONFIG,
      )).toBe(false);
    });
  });

  describe('daily reset boundary', () => {
    it('returns true for old sessions', () => {
      expect(isSessionExpired(
        makeSession(daysAgo(2)),
        { resetHour: SAFE_RESET_HOUR, idleMinutes: 0 },
      )).toBe(true);
    });

    it('returns true for sessions from weeks ago', () => {
      expect(isSessionExpired(
        makeSession(daysAgo(14)),
        { resetHour: SAFE_RESET_HOUR, idleMinutes: 0 },
      )).toBe(true);
    });

    it('returns false for a very recent session', () => {
      expect(isSessionExpired(
        makeSession(minutesAgo(1)),
        { resetHour: SAFE_RESET_HOUR, idleMinutes: 0 },
      )).toBe(false);
    });
  });

  describe('combined checks', () => {
    it('idle expires a recent session past the idle window', () => {
      expect(isSessionExpired(
        makeSession(hoursAgo(2)),
        { resetHour: SAFE_RESET_HOUR, idleMinutes: 60 },
      )).toBe(true);
    });

    it('returns false when both checks pass (recent session)', () => {
      expect(isSessionExpired(
        makeSession(minutesAgo(5)),
        { resetHour: SAFE_RESET_HOUR, idleMinutes: 60 },
      )).toBe(false);
    });

    it('reset expires old sessions even when idle is disabled', () => {
      expect(isSessionExpired(
        makeSession(daysAgo(3)),
        { resetHour: SAFE_RESET_HOUR, idleMinutes: 0 },
      )).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('returns false for invalid updated_at', () => {
      expect(isSessionExpired(
        makeSession('invalid-date'),
        IDLE_ONLY_CONFIG,
      )).toBe(false);
    });

    it('handles resetHour at midnight (0)', () => {
      expect(isSessionExpired(
        makeSession(daysAgo(2)),
        { resetHour: 0, idleMinutes: 0 },
      )).toBe(true);
    });

    it('handles resetHour at 23', () => {
      expect(isSessionExpired(
        makeSession(daysAgo(2)),
        { resetHour: 23, idleMinutes: 0 },
      )).toBe(true);
    });

    it('accepts timezone parameter without error', () => {
      expect(isSessionExpired(
        makeSession(daysAgo(2)),
        { resetHour: SAFE_RESET_HOUR, idleMinutes: 0 },
        'Asia/Singapore',
      )).toBe(true);
    });

    it('falls back to UTC for invalid timezone', () => {
      expect(() => isSessionExpired(
        makeSession(daysAgo(2)),
        { resetHour: SAFE_RESET_HOUR, idleMinutes: 0 },
        'Invalid/Timezone',
      )).not.toThrow();
    });
  });
});
