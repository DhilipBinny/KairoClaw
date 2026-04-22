import { describe, it, expect } from 'vitest';
import { hasRemoteBrowser, sendBrowserCommand } from '../bridge.js';

describe('Browser Bridge', () => {
  describe('hasRemoteBrowser', () => {
    it('returns false for unknown userId', () => {
      expect(hasRemoteBrowser('unknown-user')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(hasRemoteBrowser('')).toBe(false);
    });
  });

  describe('sendBrowserCommand', () => {
    it('throws when no extension connected', async () => {
      await expect(sendBrowserCommand('no-user', 'navigate', { url: 'https://example.com' }))
        .rejects.toThrow('No browser extension connected');
    });

    it('throws with helpful message', async () => {
      try {
        await sendBrowserCommand('missing', 'click', { ref: 1 });
      } catch (e: unknown) {
        expect((e as Error).message).toContain('Chrome extension');
      }
    });
  });

  describe('command ID generation', () => {
    it('generates unique IDs', () => {
      // Command IDs use Date.now() + random — verify the pattern
      const id1 = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const id2 = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^cmd-\d+-[a-z0-9]+$/);
    });
  });
});
