import crypto from 'node:crypto';

/** Generate a new API key with agw_sk_ prefix */
export function generateApiKey(): string {
  return 'agw_sk_' + crypto.randomBytes(32).toString('hex');
}

/** Hash an API key for storage (SHA-256) */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Verify an API key against a stored hash (constant-time) */
export function verifyApiKey(key: string, hash: string): boolean {
  const keyHash = hashApiKey(key);
  return crypto.timingSafeEqual(new Uint8Array(Buffer.from(keyHash)), new Uint8Array(Buffer.from(hash)));
}
