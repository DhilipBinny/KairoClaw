import crypto from 'node:crypto';

/**
 * API key hashing.
 *
 * Keys are stored only as a hash. Historically that hash was a plain unsalted
 * SHA-256. We now key the hash with a server-side secret (a "pepper") derived
 * from the gateway master key, using HMAC-SHA256 — so a leaked hash database
 * cannot be attacked offline without also holding the master key, and the scheme
 * stays sound even if keys ever become shorter or user-chosen.
 *
 * Migration is transparent: existing SHA-256 hashes keep verifying via
 * {@link findUserByApiKey}, which re-hashes a matched legacy row to the new
 * HMAC on the fly. No key regeneration or manual migration is required. If no
 * master key is available the pepper is null and hashing falls back to the
 * legacy SHA-256 (no lockout).
 *
 * OPERATIONAL CAVEAT: once a key has been upgraded to the peppered hash, its
 * verification depends on the master key. If the master key is lost or rotated,
 * those keys can no longer be matched and the affected users must regenerate
 * them. The master key already protects the secrets store, so it must be kept
 * stable / backed up regardless — this does not add a new secret to manage.
 */

let pepper: Buffer | null = null;

/** Derive the API-key pepper from the gateway master key (deterministic). */
export function deriveApiKeyPepper(masterKey: Buffer): Buffer {
  return crypto.createHmac('sha256', new Uint8Array(masterKey)).update('api-key-hash-v1').digest();
}

/** Install the pepper at startup. Pass null to use legacy SHA-256 hashing. */
export function setApiKeyPepper(p: Buffer | null): void {
  pepper = p;
}

/** Generate a new API key with agw_sk_ prefix */
export function generateApiKey(): string {
  return 'agw_sk_' + crypto.randomBytes(32).toString('hex');
}

/** Legacy unsalted SHA-256 hash (used only to verify/upgrade old keys). */
export function legacyHashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Hash an API key for storage/lookup. HMAC-SHA256 with the server pepper when
 * one is installed, otherwise the legacy SHA-256.
 */
export function hashApiKey(key: string): string {
  return pepper
    ? crypto.createHmac('sha256', new Uint8Array(pepper)).update(key).digest('hex')
    : legacyHashApiKey(key);
}

interface MinimalDb {
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Look up a user row by API key, accepting both the current (peppered) hash and
 * a legacy SHA-256 hash. On a legacy match the row is transparently re-hashed to
 * the current scheme. Returns the row (with `api_key_hash` reflecting any
 * upgrade) or null.
 */
export async function findUserByApiKey<T extends { id: string; api_key_hash?: string | null }>(
  db: MinimalDb,
  key: string,
): Promise<T | null> {
  const currentHash = hashApiKey(key);
  const current = await db.get<T>('SELECT * FROM users WHERE api_key_hash = ?', [currentHash]);
  if (current) return current;

  const legacy = legacyHashApiKey(key);
  if (legacy === currentHash) return null; // pepper disabled — already checked this hash

  const row = await db.get<T>('SELECT * FROM users WHERE api_key_hash = ?', [legacy]);
  if (row) {
    await db.run('UPDATE users SET api_key_hash = ? WHERE id = ?', [currentHash, row.id]);
    row.api_key_hash = currentHash;
    return row;
  }
  return null;
}
