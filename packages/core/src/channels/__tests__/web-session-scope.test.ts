import { describe, it, expect } from 'vitest';
import { webChatId, isValidSessionKey, ownsWebSession, sessionKeyFromWebChatId, webDeliveryMatches } from '../webchat.js';

const USER_A = 'uuid-aaaa';
const USER_B = 'uuid-bbbb';

describe('web session scoping (#178)', () => {
  describe('webChatId — per-user namespacing', () => {
    it('namespaces the chat_id by client id', () => {
      expect(webChatId(USER_A, 'main')).toBe('web:uuid-aaaa:main');
    });

    it('two users with the same sessionKey get DIFFERENT chat_ids (no shared session)', () => {
      expect(webChatId(USER_A, 'main')).not.toBe(webChatId(USER_B, 'main'));
    });
  });

  describe('isValidSessionKey', () => {
    it('accepts simple tokens', () => {
      expect(isValidSessionKey('main')).toBe(true);
      expect(isValidSessionKey('session-1234-abcd')).toBe(true);
      expect(isValidSessionKey('work_2')).toBe(true);
    });

    it('rejects colons (which would forge the chat_id namespace) and other junk', () => {
      expect(isValidSessionKey('uuid-bbbb:main')).toBe(false); // colon → namespace forgery
      expect(isValidSessionKey('a/b')).toBe(false);
      expect(isValidSessionKey('a b')).toBe(false);
      expect(isValidSessionKey('')).toBe(false);
      expect(isValidSessionKey('x'.repeat(201))).toBe(false);
    });
  });

  describe('ownsWebSession — access control', () => {
    it('admin can access any session', () => {
      expect(ownsWebSession({ user_id: USER_B, chat_id: webChatId(USER_B, 'main') }, USER_A, 'admin')).toBe(true);
    });

    it('user can access their own user-owned session', () => {
      expect(ownsWebSession({ user_id: USER_A, chat_id: webChatId(USER_A, 'main') }, USER_A, 'user')).toBe(true);
    });

    it("user CANNOT access another user's user-owned session", () => {
      expect(ownsWebSession({ user_id: USER_B, chat_id: webChatId(USER_B, 'main') }, USER_A, 'user')).toBe(false);
    });

    it('null-owner (anon/gateway) session is owned only when chat_id is in the caller namespace', () => {
      // own namespace → allowed
      expect(ownsWebSession({ user_id: null, chat_id: webChatId(USER_A, 'main') }, USER_A, 'user')).toBe(true);
      // another client's namespace → denied (closes the world-readable null-owner leak)
      expect(ownsWebSession({ user_id: null, chat_id: webChatId(USER_B, 'main') }, USER_A, 'user')).toBe(false);
    });

    it('legacy unscoped "web:main" null-owner session is NOT world-readable', () => {
      expect(ownsWebSession({ user_id: null, chat_id: 'web:main' }, USER_A, 'user')).toBe(false);
    });
  });

  describe('webDeliveryMatches — per-user routing (#191)', () => {
    const a = { sessionKey: 'uuid-aaaa:main', clientId: USER_A, role: 'user' };
    const b = { sessionKey: 'uuid-bbbb:main', clientId: USER_B, role: 'admin' };

    it('userId filter delivers only to that user\'s connections', () => {
      expect(webDeliveryMatches(a, { userId: USER_A })).toBe(true);
      expect(webDeliveryMatches(b, { userId: USER_A })).toBe(false); // another user never receives
    });
    it('adminOnly filter delivers only to admin connections', () => {
      expect(webDeliveryMatches(b, { adminOnly: true })).toBe(true);
      expect(webDeliveryMatches(a, { adminOnly: true })).toBe(false);
    });
    it('sessionKey filter restricts to one bound session', () => {
      expect(webDeliveryMatches(a, { sessionKey: 'uuid-aaaa:main' })).toBe(true);
      expect(webDeliveryMatches(a, { sessionKey: 'uuid-bbbb:main' })).toBe(false);
    });
    it('empty filter is the only case that reaches everyone', () => {
      expect(webDeliveryMatches(a, {})).toBe(true);
      expect(webDeliveryMatches(b, {})).toBe(true);
    });
  });

  describe('sessionKeyFromWebChatId — list responses surface the bare key only', () => {
    it('strips the clientId segment from a scoped chat_id', () => {
      expect(sessionKeyFromWebChatId(webChatId(USER_A, 'main'))).toBe('main');
      expect(sessionKeyFromWebChatId('web:web-1-abcd:work_2')).toBe('work_2');
    });
    it('handles legacy and non-web chat_ids', () => {
      expect(sessionKeyFromWebChatId('web:main')).toBe('main');
      expect(sessionKeyFromWebChatId('telegram:1')).toBe('telegram:1');
      expect(sessionKeyFromWebChatId(null)).toBe('');
    });
    it('round-trips with webChatId', () => {
      for (const key of ['main', 'session-abc', 'work_2']) {
        expect(sessionKeyFromWebChatId(webChatId(USER_A, key))).toBe(key);
      }
    });
  });
});
