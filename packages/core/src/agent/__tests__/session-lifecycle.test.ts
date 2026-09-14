import { describe, it, expect } from 'vitest';
import { isSessionExpired } from '../session-lifecycle.js';
import type { SessionRow } from '../../db/repositories/session.js';

const DEFAULT_CONFIG = { resetHour: 4, idleMinutes: 60 };

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
        makeSession(hoursAgo(2)),
        { resetHour: 4, idleMinutes: 0 },
      )).toBe(false);
    });

    it('returns true when idle longer than idleMinutes', () => {
      expect(isSessionExpired(
        makeSession(hoursAgo(2)),
        DEFAULT_CONFIG,
      )).toBe(true);
    });

    it('returns false when within idle window', () => {
      expect(isSessionExpired(
        makeSession(minutesAgo(5)),
        DEFAULT_CONFIG,
      )).toBe(false);
    });

    it('returns true just past the boundary', () => {
      const justPast = new Date(Date.now() - 60 * 60_000 - 1).toISOString();
      expect(isSessionExpired(
        makeSession(justPast),
        DEFAULT_CONFIG,
      )).toBe(true);
    });

    it('returns false just before the boundary', () => {
      const justBefore = new Date(Date.now() - 60 * 60_000 + 30_000).toISOString();
      expect(isSessionExpired(
        makeSession(justBefore),
        DEFAULT_CONFIG,
      )).toBe(false);
    });
  });

  describe('daily reset boundary', () => {
    it('returns true for a session from yesterday', () => {
      expect(isSessionExpired(
        makeSession(daysAgo(2)),
        { resetHour: 4, idleMinutes: 0 },
      )).toBe(true);
    });

    it('returns true for a session from weeks ago', () => {
      expect(isSessionExpired(
        makeSession(daysAgo(14)),
        { resetHour: 4, idleMinutes: 0 },
      )).toBe(true);
    });

    it('returns false for a very recent session even with resetHour', () => {
      expect(isSessionExpired(
        makeSession(minutesAgo(1)),
        { resetHour: 4, idleMinutes: 0 },
      )).toBe(false);
    });
  });

  describe('combined checks', () => {
    it('idle wins when session is within reset window but past idle', () => {
      expect(isSessionExpired(
        makeSession(hoursAgo(2)),
        { resetHour: 4, idleMinutes: 60 },
      )).toBe(true);
    });

    it('returns false when both checks pass (recent session)', () => {
      expect(isSessionExpired(
        makeSession(minutesAgo(5)),
        { resetHour: 4, idleMinutes: 60 },
      )).toBe(false);
    });

    it('reset wins when session is old but idleMinutes is disabled', () => {
      expect(isSessionExpired(
        makeSession(daysAgo(3)),
        { resetHour: 4, idleMinutes: 0 },
      )).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('returns false for invalid updated_at', () => {
      expect(isSessionExpired(
        makeSession('invalid-date'),
        DEFAULT_CONFIG,
      )).toBe(false);
    });

    it('handles resetHour at midnight (0)', () => {
      expect(isSessionExpired(
        makeSession(daysAgo(1)),
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
        makeSession(daysAgo(1)),
        { resetHour: 4, idleMinutes: 0 },
        'Asia/Singapore',
      )).toBe(true);
    });

    it('falls back to UTC for invalid timezone', () => {
      expect(() => isSessionExpired(
        makeSession(daysAgo(1)),
        { resetHour: 4, idleMinutes: 0 },
        'Invalid/Timezone',
      )).not.toThrow();
    });
  });
});
