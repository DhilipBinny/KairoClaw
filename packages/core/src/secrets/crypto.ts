/**
 * Envelope Encryption for Secrets Store
 *
 * Architecture:
 *   Master Key (KEK) → encrypts per-namespace DEKs
 *   Per-namespace DEK → encrypts that namespace's secret values
 *
 * File format (secrets.enc):
 * {
 *   version: 2,
 *   cipher: "aes-256-gcm",
 *   kek_check: { iv, data, tag },          // encrypted known plaintext to verify KEK
 *   namespaces: {
 *     "providers.anthropic": { dek, iv, data, tag },
 *     "channels.telegram":   { dek, iv, data, tag },
 *   },
 *   mac: "<HMAC-SHA256 hex>",
 *   updated_at: "ISO timestamp"
 * }
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────

export interface EncryptedNamespace {
  dek: string;  // DEK encrypted by KEK (base64)
  iv: string;   // AES-GCM IV (base64)
  data: string; // encrypted JSON values (base64)
  tag: string;  // GCM auth tag (base64)
}

export interface EncryptedStore {
  version: 2;
  cipher: 'aes-256-gcm';
  kek_check: { iv: string; data: string; tag: string };
  namespaces: Record<string, EncryptedNamespace>;
  mac: string;
  updated_at: string;
}

const KEK_CHECK_PLAINTEXT = 'kairoclaw-kek-verify';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;  // 128 bits (recommended for GCM)
const TAG_LENGTH = 16; // 128 bits

// Helper: Buffer → Uint8Array for TypeScript strict mode compatibility with Node crypto APIs
function toU8(buf: Buffer): Uint8Array { return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength); }

// ── Master Key Resolution ────────────────────────────────────

/**
 * Resolve the master encryption key (KEK).
 * Priority: AGW_MASTER_KEY env var → master.key file → auto-generate.
 * Returns null if encryption should be skipped (no key available and auto-gen disabled).
 */
export function resolveMasterKey(stateDir: string): Buffer | null {
  // 1. Environment variable (base64-encoded)
  const envKey = process.env.AGW_MASTER_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, 'base64');
    if (buf.length !== KEY_LENGTH) {
      console.error(`[secrets] AGW_MASTER_KEY must be ${KEY_LENGTH} bytes (base64-encoded). Got ${buf.length} bytes.`);
      return null;
    }
    return buf;
  }

  // 2. Keyfile
  const keyFilePath = path.join(stateDir, 'master.key');
  if (fs.existsSync(keyFilePath)) {
    const buf = fs.readFileSync(keyFilePath);
    if (buf.length !== KEY_LENGTH) {
      console.error(`[secrets] master.key must be ${KEY_LENGTH} bytes. Got ${buf.length} bytes.`);
      return null;
    }
    return buf;
  }

  // 3. Auto-generate
  const newKey = crypto.randomBytes(KEY_LENGTH);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(keyFilePath, toU8(newKey), { mode: 0o600 });

  console.log('\n' + '='.repeat(60));
  console.log('  ENCRYPTION KEY GENERATED');
  console.log(`  Location: ${keyFilePath}`);
  console.log('');
  console.log('  BACK UP THIS FILE! Without it, encrypted secrets');
  console.log('  cannot be recovered.');
  console.log('');
  console.log('  For cloud deploys, set AGW_MASTER_KEY env var:');
  console.log('  cat master.key | base64');
  console.log('='.repeat(60) + '\n');

  return newKey;
}

// ── Low-level Crypto ─────────────────────────────────────────

/** Encrypt plaintext with a key using AES-256-GCM. Returns { iv, data, tag } all base64. */
function aesEncrypt(plaintext: Buffer, key: Buffer): { iv: string; data: string; tag: string } {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, toU8(key), toU8(iv), { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([toU8(cipher.update(toU8(plaintext))), toU8(cipher.final())]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/** Decrypt ciphertext with a key using AES-256-GCM. */
function aesDecrypt(encrypted: { iv: string; data: string; tag: string }, key: Buffer): Buffer {
  const iv = Buffer.from(encrypted.iv, 'base64');
  const data = Buffer.from(encrypted.data, 'base64');
  const tag = Buffer.from(encrypted.tag, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, toU8(key), toU8(iv), { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(toU8(tag));
  return Buffer.concat([toU8(decipher.update(toU8(data))), toU8(decipher.final())]);
}

/** Encrypt a DEK with the KEK. */
function encryptDEK(dek: Buffer, kek: Buffer): string {
  const result = aesEncrypt(dek, kek);
  // Pack iv + tag + data into a single base64 string for compact storage
  const packed = Buffer.concat([
    toU8(Buffer.from(result.iv, 'base64')),
    toU8(Buffer.from(result.tag, 'base64')),
    toU8(Buffer.from(result.data, 'base64')),
  ]);
  return packed.toString('base64');
}

/** Decrypt a DEK with the KEK. */
function decryptDEK(encryptedDEK: string, kek: Buffer): Buffer {
  const packed = Buffer.from(encryptedDEK, 'base64');
  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const data = packed.subarray(IV_LENGTH + TAG_LENGTH);
  return aesDecrypt({
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: tag.toString('base64'),
  }, kek);
}

// ── KEK Verification ─────────────────────────────────────────

/** Create a KEK check blob — encrypts known plaintext so we can verify the key later. */
function createKEKCheck(kek: Buffer): { iv: string; data: string; tag: string } {
  return aesEncrypt(Buffer.from(KEK_CHECK_PLAINTEXT, 'utf8'), kek);
}

/** Verify that a KEK is correct by decrypting the check blob. */
export function verifyKEK(check: { iv: string; data: string; tag: string }, kek: Buffer): boolean {
  try {
    const decrypted = aesDecrypt(check, kek);
    return decrypted.toString('utf8') === KEK_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

// ── Namespace Encryption ─────────────────────────────────────

/** Encrypt a single namespace's values. Generates a fresh DEK and IV. */
export function encryptNamespace(
  values: Record<string, string>,
  kek: Buffer,
): EncryptedNamespace {
  const dek = crypto.randomBytes(KEY_LENGTH);
  const plaintext = Buffer.from(JSON.stringify(values), 'utf8');
  const { iv, data, tag } = aesEncrypt(plaintext, dek);
  return {
    dek: encryptDEK(dek, kek),
    iv,
    data,
    tag,
  };
}

/** Decrypt a single namespace's values. */
export function decryptNamespace(
  ns: EncryptedNamespace,
  kek: Buffer,
): Record<string, string> {
  const dek = decryptDEK(ns.dek, kek);
  const plaintext = aesDecrypt({ iv: ns.iv, data: ns.data, tag: ns.tag }, dek);
  return JSON.parse(plaintext.toString('utf8'));
}

// ── MAC (Tamper Detection) ───────────────────────────────────

/** Compute HMAC-SHA256 over all namespace ciphertext for tamper detection. */
export function computeMAC(namespaces: Record<string, EncryptedNamespace>, kek: Buffer): string {
  const hmac = crypto.createHmac('sha256', toU8(kek));
  // Sort keys for deterministic ordering
  const sortedKeys = Object.keys(namespaces).sort();
  for (const key of sortedKeys) {
    const ns = namespaces[key];
    hmac.update(key);
    hmac.update(ns.dek);
    hmac.update(ns.iv);
    hmac.update(ns.data);
    hmac.update(ns.tag);
  }
  return hmac.digest('hex');
}

/** Verify the MAC over all namespace ciphertext. */
export function verifyMAC(
  namespaces: Record<string, EncryptedNamespace>,
  mac: string,
  kek: Buffer,
): boolean {
  const computed = computeMAC(namespaces, kek);
  // Timing-safe comparison
  if (computed.length !== mac.length) return false;
  return crypto.timingSafeEqual(new Uint8Array(Buffer.from(computed)), new Uint8Array(Buffer.from(mac)));
}

// ── Full Store Encryption/Decryption ─────────────────────────

/** Encrypt an entire secrets store (all namespaces) into the encrypted format. */
export function encryptStore(
  data: Record<string, Record<string, string>>,
  kek: Buffer,
): EncryptedStore {
  const namespaces: Record<string, EncryptedNamespace> = {};
  for (const [nsKey, values] of Object.entries(data)) {
    namespaces[nsKey] = encryptNamespace(values, kek);
  }
  return {
    version: 2,
    cipher: ALGORITHM,
    kek_check: createKEKCheck(kek),
    namespaces,
    mac: computeMAC(namespaces, kek),
    updated_at: new Date().toISOString(),
  };
}

/** Decrypt an entire encrypted store back to plaintext namespaces. */
export function decryptStore(
  store: EncryptedStore,
  kek: Buffer,
): Record<string, Record<string, string>> {
  // 1. Verify KEK
  if (!verifyKEK(store.kek_check, kek)) {
    throw new Error('Invalid master key — cannot decrypt secrets. Check AGW_MASTER_KEY or master.key file.');
  }

  // 2. Verify MAC (tamper detection)
  if (!verifyMAC(store.namespaces, store.mac, kek)) {
    throw new Error('Secrets file tampered — MAC verification failed. The file may have been modified externally.');
  }

  // 3. Decrypt each namespace
  const data: Record<string, Record<string, string>> = {};
  for (const [nsKey, encrypted] of Object.entries(store.namespaces)) {
    data[nsKey] = decryptNamespace(encrypted, kek);
  }
  return data;
}

// ── File I/O ─────────────────────────────────────────────────

/** Write encrypted store to disk atomically (write tmp + rename). */
export function writeEncryptedStore(filePath: string, store: EncryptedStore): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

/** Read encrypted store from disk. Returns null if file doesn't exist. */
export function readEncryptedStore(filePath: string): EncryptedStore | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.version !== 2 || parsed.cipher !== ALGORITHM) {
    throw new Error(`Unsupported secrets.enc format: version=${parsed.version}, cipher=${parsed.cipher}`);
  }
  if (!parsed.kek_check || !parsed.namespaces || !parsed.mac) {
    throw new Error('Malformed secrets.enc: missing required fields (kek_check, namespaces, mac)');
  }
  return parsed as EncryptedStore;
}
