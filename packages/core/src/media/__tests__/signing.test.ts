import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { createMediaUrlSigner, deriveMediaSigningKey } from '../signing.js';

const key = crypto.randomBytes(32);

describe('media URL signer', () => {
  it('verifies a freshly signed grant', () => {
    const s = createMediaUrlSigner(key);
    const { expires, sig } = s.sign('abc.png');
    expect(s.verify('abc.png', expires, sig, Date.now())).toBe(true);
  });

  it('rejects an expired grant', () => {
    const s = createMediaUrlSigner(key);
    const { expires, sig } = s.sign('abc.png', -1000); // already in the past
    expect(s.verify('abc.png', expires, sig, Date.now())).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const s = createMediaUrlSigner(key);
    const { expires, sig } = s.sign('abc.png');
    const bad = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(s.verify('abc.png', expires, sig, Date.now())).toBe(true);
    expect(s.verify('abc.png', expires, bad, Date.now())).toBe(false);
  });

  it('rejects a signature bound to a different filename', () => {
    const s = createMediaUrlSigner(key);
    const { expires, sig } = s.sign('abc.png');
    expect(s.verify('other.png', expires, sig, Date.now())).toBe(false);
  });

  it('rejects a signature minted with a different key', () => {
    const a = createMediaUrlSigner(key);
    const b = createMediaUrlSigner(crypto.randomBytes(32));
    const { expires, sig } = a.sign('abc.png');
    expect(b.verify('abc.png', expires, sig, Date.now())).toBe(false);
  });

  it('rejects a tampered expiry (extending the window)', () => {
    const s = createMediaUrlSigner(key);
    const { expires, sig } = s.sign('abc.png', 1000);
    // Push the deadline far out without re-signing — must fail.
    expect(s.verify('abc.png', expires + 10 * 365 * 24 * 3600_000, sig, Date.now())).toBe(false);
  });

  it('rejects missing/garbage params', () => {
    const s = createMediaUrlSigner(key);
    const { expires, sig } = s.sign('abc.png');
    expect(s.verify('abc.png', expires, '', Date.now())).toBe(false);
    expect(s.verify('abc.png', NaN, sig, Date.now())).toBe(false);
  });

  it('signUrl appends parsable, verifiable params', () => {
    const s = createMediaUrlSigner(key);
    const url = s.signUrl('/api/v1/media/abc.png', 'abc.png');
    const u = new URL(url, 'http://x');
    const expires = Number(u.searchParams.get('expires'));
    const sig = u.searchParams.get('sig')!;
    expect(s.verify('abc.png', expires, sig, Date.now())).toBe(true);
    expect(url.startsWith('/api/v1/media/abc.png?')).toBe(true);
  });

  it('signUrl uses & when the url already has a query', () => {
    const s = createMediaUrlSigner(key);
    const url = s.signUrl('http://h/api/v1/media/abc.png?x=1', 'abc.png');
    expect(url).toContain('?x=1&expires=');
  });

  it('derives a deterministic key from the master key', () => {
    const mk = crypto.randomBytes(32);
    expect(deriveMediaSigningKey(mk).equals(deriveMediaSigningKey(mk))).toBe(true);
    expect(deriveMediaSigningKey(mk).equals(deriveMediaSigningKey(crypto.randomBytes(32)))).toBe(false);
  });
});
