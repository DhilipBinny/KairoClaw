import { describe, it, expect } from 'vitest';
import { deriveScopeKey, deriveGroupScopeKey } from '../scope.js';

describe('deriveScopeKey', () => {
  // Resolved user UUID takes priority
  it('returns resolved user UUID when provided', () => {
    expect(deriveScopeKey('telegram', '8606526093', 'abc-123-uuid')).toBe('abc-123-uuid');
  });

  it('returns resolved UUID for whatsapp too', () => {
    expect(deriveScopeKey('whatsapp', '6580961895', 'xyz-789-uuid')).toBe('xyz-789-uuid');
  });

  it('returns resolved UUID for web', () => {
    expect(deriveScopeKey('web', 'browser-id', 'user-uuid')).toBe('user-uuid');
  });

  // Fallback to channel:senderId
  it('falls back to channel:senderId when no resolved user', () => {
    expect(deriveScopeKey('telegram', '8606526093')).toBe('telegram:8606526093');
  });

  it('falls back for whatsapp', () => {
    expect(deriveScopeKey('whatsapp', '6580961895')).toBe('whatsapp:6580961895');
  });

  // Null cases
  it('returns null for cron channel', () => {
    expect(deriveScopeKey('cron', 'system')).toBeNull();
  });

  it('returns null for internal channel', () => {
    expect(deriveScopeKey('internal', 'sub-123')).toBeNull();
  });

  it('returns null when no userId', () => {
    expect(deriveScopeKey('telegram', undefined)).toBeNull();
  });

  it('returns null for system userId', () => {
    expect(deriveScopeKey('telegram', 'system')).toBeNull();
  });

  it('returns null for anonymous userId', () => {
    expect(deriveScopeKey('web', 'anonymous')).toBeNull();
  });

  // Security — path traversal
  it('returns null for userId with path traversal', () => {
    expect(deriveScopeKey('telegram', '../etc/passwd')).toBeNull();
  });

  it('returns null for userId with slashes', () => {
    expect(deriveScopeKey('telegram', 'user/../../root')).toBeNull();
  });

  it('rejects resolved UUID with path traversal — falls back to channel:sender', () => {
    // Bad UUID is rejected, falls back to channel:senderId (safe)
    expect(deriveScopeKey('telegram', '123', '../evil')).toBe('telegram:123');
  });
});

describe('deriveGroupScopeKey', () => {
  it('returns group scope for telegram group', () => {
    const result = deriveGroupScopeKey('telegram', 'telegram:-1003319503773');
    expect(result).toMatch(/^group_telegram_/);
    expect(result).toContain('1003319503773');
  });

  it('returns group scope for whatsapp group', () => {
    const result = deriveGroupScopeKey('whatsapp', 'whatsapp:120363408838097788@g.us');
    expect(result).toMatch(/^group_whatsapp_/);
  });

  it('returns null for non-scoped channel', () => {
    expect(deriveGroupScopeKey('cron', 'cron:123')).toBeNull();
  });

  it('rejects chatId with path traversal', () => {
    // chatId containing / or .. is rejected (returns null)
    const result = deriveGroupScopeKey('telegram', 'telegram:-100/../../evil');
    expect(result).toBeNull();
  });
});
