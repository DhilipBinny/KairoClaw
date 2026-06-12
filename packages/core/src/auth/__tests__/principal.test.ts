import { describe, it, expect } from 'vitest';
import { resolvePrincipal } from '../principal.js';

describe('resolvePrincipal (#179 cron privilege escalation)', () => {
  it('returns the resolved user\'s own role and elevation', () => {
    const p = resolvePrincipal('internal', 'user-123', { id: 'user-123', role: 'user', elevated: 0 });
    expect(p).toEqual({ id: 'user-123', role: 'user', elevated: false });
  });

  it('preserves an elevated resolved user', () => {
    const p = resolvePrincipal('telegram', 'user-9', { id: 'user-9', role: 'admin', elevated: 1 });
    expect(p).toEqual({ id: 'user-9', role: 'admin', elevated: true });
  });

  it('grants system admin to a system-owned cron (no specific user)', () => {
    expect(resolvePrincipal('cron', 'system', undefined)).toEqual({ id: 'system', role: 'admin', elevated: true });
    expect(resolvePrincipal('cron', undefined, undefined)).toEqual({ id: 'system', role: 'admin', elevated: true });
    expect(resolvePrincipal('heartbeat', undefined, undefined)).toEqual({ id: 'system', role: 'admin', elevated: true });
  });

  it('REFUSES a user-owned cron whose owner is deactivated (the escalation hole)', () => {
    // internal channel + specific claimed owner that did NOT resolve to an
    // active user → must NOT escalate to system admin.
    expect(resolvePrincipal('internal', 'deactivated-user', undefined)).toBeNull();
    expect(resolvePrincipal('cron', 'deactivated-user', undefined)).toBeNull();
    expect(resolvePrincipal('heartbeat', 'deactivated-user', undefined)).toBeNull();
  });

  it('does NOT refuse — but restricts — an unlinked real channel sender', () => {
    // A Telegram user with no linked account is anonymous/restricted, never admin.
    const p = resolvePrincipal('telegram', 'tg-sender-1', undefined);
    expect(p).toEqual({ id: 'anonymous', role: 'user', elevated: false });
  });

  it('lets an active user-owned cron run as its owner, not admin', () => {
    const p = resolvePrincipal('internal', 'user-7', { id: 'user-7', role: 'user', elevated: 0 });
    expect(p).not.toBeNull();
    expect(p!.role).toBe('user');
    expect(p!.elevated).toBe(false);
    expect(p!.id).toBe('user-7');
  });
});
