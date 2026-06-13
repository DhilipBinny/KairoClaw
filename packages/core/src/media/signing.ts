/**
 * Signed media URLs.
 *
 * The media route (`GET /api/v1/media/:filename`) cannot require an
 * Authorization header, because media is loaded by plain `<img>`/external
 * fetchers that can't set one. Instead of leaving the route open to anyone who
 * guesses a filename, we mint short-lived signed URLs:
 *
 *   /api/v1/media/<file>?expires=<ms>&sig=<base64url-hmac>
 *
 * The signature is an HMAC-SHA256 over the (filename, expiry) pair keyed by a
 * secret derived from the gateway master key. A request that carries a valid,
 * unexpired signature is served; anything else must authenticate normally
 * (Bearer token or `?token=` API key). Forging a signature requires the master
 * key, so an attacker who only knows a filename can no longer fetch it.
 */
import crypto from 'node:crypto';
import { MEDIA_URL_TTL_MS } from '../constants.js';

const SIGN_LABEL = 'media-url-signing-v1';

export interface MediaUrlSigner {
  /** Produce the `{ expires, sig }` grant for a (raw, un-encoded) filename. */
  sign(filename: string, ttlMs?: number): { expires: number; sig: string };
  /**
   * Append `?expires=&sig=` to a media URL/path whose last segment is the
   * URL-encoded `filename`. `filename` is the raw (decoded) name to sign.
   */
  signUrl(url: string, filename: string, ttlMs?: number): string;
  /** True if `sig` matches `filename`+`expires` and `expires` is in the future. */
  verify(filename: string, expires: number, sig: string, nowMs: number): boolean;
}

/**
 * Derive the media-signing key from the gateway master key. Deterministic, so
 * signatures stay valid across restarts without storing a separate secret.
 */
export function deriveMediaSigningKey(masterKey: Buffer): Buffer {
  return crypto.createHmac('sha256', new Uint8Array(masterKey)).update(SIGN_LABEL).digest();
}

export function createMediaUrlSigner(
  signingKey: Buffer,
  defaultTtlMs: number = MEDIA_URL_TTL_MS,
): MediaUrlSigner {
  const key = new Uint8Array(signingKey);

  function compute(filename: string, expires: number): string {
    return crypto
      .createHmac('sha256', key)
      .update(filename)
      .update('\n')
      .update(String(expires))
      .digest('base64url');
  }

  return {
    sign(filename, ttlMs = defaultTtlMs) {
      const expires = Date.now() + ttlMs;
      return { expires, sig: compute(filename, expires) };
    },

    signUrl(url, filename, ttlMs) {
      const { expires, sig } = this.sign(filename, ttlMs);
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}expires=${expires}&sig=${sig}`;
    },

    verify(filename, expires, sig, nowMs) {
      if (!sig || !Number.isFinite(expires) || expires < nowMs) return false;
      const expected = compute(filename, expires);
      // Constant-time compare; length check first because timingSafeEqual throws
      // on length mismatch.
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
    },
  };
}
