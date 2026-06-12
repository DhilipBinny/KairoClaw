import { describe, it, expect } from 'vitest';
import { sessionKeyFromChatId } from '../session-key.js';

describe('sessionKeyFromChatId (#178 UI extraction)', () => {
  it('extracts the bare key from a user-scoped chat_id', () => {
    expect(sessionKeyFromChatId('web:uuid-aaaa:main')).toBe('main');
    expect(sessionKeyFromChatId('web:web-123-abcd:work_2')).toBe('work_2');
  });

  it('round-trips: extracted key never re-introduces the client prefix', () => {
    // The UI sends back the bare key; the server re-scopes it. Extracting must
    // yield exactly the original sessionKey so no double-prefixing occurs.
    for (const key of ['main', 'session-abc', 'work_2']) {
      expect(sessionKeyFromChatId(`web:uuid-aaaa:${key}`)).toBe(key);
    }
  });

  it('tolerates legacy unscoped web:<key> chat_ids', () => {
    expect(sessionKeyFromChatId('web:main')).toBe('main');
  });

  it('returns non-web chat_ids unchanged', () => {
    expect(sessionKeyFromChatId('telegram:123')).toBe('telegram:123');
    expect(sessionKeyFromChatId('')).toBe('');
  });
});
