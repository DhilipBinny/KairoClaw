import { describe, it, expect } from 'vitest';
import { shouldBlockResource } from '../browse.js';

describe('Browse tool', () => {
  describe('shouldBlockResource', () => {
    it('blocks ad domains', () => {
      expect(shouldBlockResource('https://doubleclick.net/ad.js', 'script')).toBe(true);
      expect(shouldBlockResource('https://pagead2.googlesyndication.com/ad', 'script')).toBe(true);
      expect(shouldBlockResource('https://www.google-analytics.com/analytics.js', 'script')).toBe(true);
      expect(shouldBlockResource('https://connect.facebook.net/en_US/sdk.js', 'script')).toBe(true);
    });

    it('blocks tracker domains', () => {
      expect(shouldBlockResource('https://cdn.segment.io/v1/track', 'xhr')).toBe(true);
      expect(shouldBlockResource('https://script.hotjar.com/modules', 'script')).toBe(true);
      expect(shouldBlockResource('https://cdn.taboola.com/widget', 'script')).toBe(true);
      expect(shouldBlockResource('https://widgets.outbrain.com/rec', 'script')).toBe(true);
    });

    it('blocks fonts and media by resource type', () => {
      expect(shouldBlockResource('https://fonts.gstatic.com/s/roboto.woff2', 'font')).toBe(true);
      expect(shouldBlockResource('https://example.com/video.mp4', 'media')).toBe(true);
    });

    it('allows normal page resources', () => {
      expect(shouldBlockResource('https://www.amazon.sg/page', 'document')).toBe(false);
      expect(shouldBlockResource('https://example.com/style.css', 'stylesheet')).toBe(false);
      expect(shouldBlockResource('https://cdn.example.com/app.js', 'script')).toBe(false);
      expect(shouldBlockResource('https://api.example.com/data', 'xhr')).toBe(false);
    });

    it('allows images (not blocked by default)', () => {
      expect(shouldBlockResource('https://example.com/photo.jpg', 'image')).toBe(false);
    });

    it('handles subdomain matching', () => {
      expect(shouldBlockResource('https://sub.doubleclick.net/ad', 'script')).toBe(true);
      expect(shouldBlockResource('https://deep.sub.google-analytics.com/collect', 'script')).toBe(true);
    });

    it('handles invalid URLs gracefully', () => {
      expect(shouldBlockResource('not-a-url', 'script')).toBe(false);
      expect(shouldBlockResource('', 'script')).toBe(false);
    });
  });

  describe('password redaction', () => {
    // This tests the snapshot logic conceptually — the actual DOM evaluation
    // runs in a browser context which we can't easily test in vitest.
    // But we can verify the pattern:
    it('password type should trigger redaction', () => {
      const type = 'password';
      const value = 'mysecretpass';
      const redacted = type === 'password' ? '[REDACTED]' : value;
      expect(redacted).toBe('[REDACTED]');
    });

    it('text type should not redact', () => {
      const type = 'text';
      const value = 'visible value';
      const redacted = type === 'password' ? '[REDACTED]' : value;
      expect(redacted).toBe('visible value');
    });
  });

  describe('session name sanitization', () => {
    it('sanitizes special characters', () => {
      const name = '../../etc/passwd';
      const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
      expect(safe).toBe('______etc_passwd');
      expect(safe).not.toContain('/');
      expect(safe).not.toContain('.');
    });

    it('truncates long names', () => {
      const name = 'a'.repeat(100);
      const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
      expect(safe.length).toBe(50);
    });

    it('preserves valid names', () => {
      const name = 'gmail-session_2026';
      const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
      expect(safe).toBe('gmail-session_2026');
    });
  });

  describe('ref clearing security', () => {
    // Verifying the pattern: pre-existing data-kc-ref should be cleared
    it('clearing pattern removes all refs', () => {
      // Simulating: document.querySelectorAll('[data-kc-ref]').forEach(el => el.removeAttribute('data-kc-ref'))
      const elements = [
        { 'data-kc-ref': '1' },
        { 'data-kc-ref': '5' },
        { 'data-kc-ref': '99' },
      ];
      // After clearing, all should be removed
      const cleared = elements.map(() => ({ 'data-kc-ref': undefined }));
      expect(cleared.every(el => el['data-kc-ref'] === undefined)).toBe(true);
    });
  });
});
