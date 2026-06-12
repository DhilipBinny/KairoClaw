import { describe, it, expect } from 'vitest';
import { webChatId, isValidSessionKey, ownsWebSession } from '../webchat.js';

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
});
