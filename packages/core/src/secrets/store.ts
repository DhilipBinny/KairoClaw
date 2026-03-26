/**
 * Unified Secrets Store — single source of truth for ALL secrets.
 *
 * When a master key (KEK) is provided, secrets are stored encrypted
 * in secrets.enc using per-namespace envelope encryption (AES-256-GCM).
 * Without a key, falls back to plaintext secrets.json (with warning).
 *
 * Format (plaintext — legacy/fallback):
 * {
 *   "providers.anthropic": { "apiKey": "<key>", "authToken": "<token>" },
 *   ...
 * }
 *
 * Format (encrypted — secrets.enc):
 * See crypto.ts for EncryptedStore schema.
 *
 * Namespaces:
 *   providers.*  — LLM provider credentials
 *   channels.*   — messaging channel tokens
 *   tools.*      — built-in tool API keys
 *   gateway      — Kairo admin/API token
 *   mcp.*        — MCP server env vars (per-server)
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  encryptStore,
  decryptStore,
  writeEncryptedStore,
  readEncryptedStore,
} from './crypto.js';

export class SecretsStore {
  private plaintextPath: string;
  private encryptedPath: string;
  private kek: Buffer | null;
  private data: Record<string, Record<string, string>> | null = null;
  private cacheTime = 0;
  private encrypted = false;
  private static CACHE_TTL_MS = 5000;

  constructor(stateDir: string, masterKey?: Buffer | null, options?: { quiet?: boolean }) {
    this.plaintextPath = path.join(stateDir, 'secrets.json');
    this.encryptedPath = path.join(stateDir, 'secrets.enc');
    this.kek = masterKey ?? null;

    if (this.kek) {
      this._migrateToEncrypted();
      // Only mark as encrypted if secrets.enc actually exists (migration may have failed)
      this.encrypted = fs.existsSync(this.encryptedPath);
      if (!this.encrypted && !options?.quiet) {
        console.warn('[secrets] Master key provided but encryption failed — falling back to plaintext.');
      }
    } else if (!options?.quiet) {
      console.warn('[secrets] No master key — secrets stored as plaintext. Set AGW_MASTER_KEY for encryption.');
    }
  }

  /** True if the store is using encryption. */
  get isEncrypted(): boolean {
    return this.encrypted;
  }

  /** True if decrypt failed — store is returning empty data and refusing writes. */
  get isDegraded(): boolean {
    return this.decryptFailed;
  }

  // ── Migration ──────────────────────────────────────────────

  /**
   * One-time migration: plaintext secrets.json → encrypted secrets.enc.
   * Only runs if secrets.enc doesn't exist and secrets.json does.
   */
  private _migrateToEncrypted(): void {
    if (!this.kek) return;

    // Already encrypted
    if (fs.existsSync(this.encryptedPath)) {
      // Clean up leftover plaintext if it exists
      if (fs.existsSync(this.plaintextPath)) {
        try { fs.unlinkSync(this.plaintextPath); } catch { /* ignore */ }
      }
      return;
    }

    // No plaintext to migrate — fresh install
    if (!fs.existsSync(this.plaintextPath)) return;

    // Read plaintext
    let plainData: Record<string, Record<string, string>>;
    try {
      const raw = fs.readFileSync(this.plaintextPath, 'utf8');
      plainData = JSON.parse(raw);
      if (!plainData || typeof plainData !== 'object') return;
    } catch {
      return; // corrupt or empty — skip migration
    }

    // Encrypt
    const encStore = encryptStore(plainData, this.kek);

    // Write encrypted
    writeEncryptedStore(this.encryptedPath, encStore);

    // Verify: can we decrypt it back?
    try {
      const readBack = readEncryptedStore(this.encryptedPath);
      if (!readBack) throw new Error('Failed to read back encrypted store');
      const decrypted = decryptStore(readBack, this.kek);

      // Deep compare
      const origKeys = Object.keys(plainData).sort();
      const decKeys = Object.keys(decrypted).sort();
      if (JSON.stringify(origKeys) !== JSON.stringify(decKeys)) {
        throw new Error('Namespace key mismatch after round-trip');
      }
      for (const ns of origKeys) {
        if (JSON.stringify(plainData[ns]) !== JSON.stringify(decrypted[ns])) {
          throw new Error(`Values mismatch in namespace ${ns}`);
        }
      }
    } catch (e) {
      // Verification failed — remove encrypted file, keep plaintext
      try { fs.unlinkSync(this.encryptedPath); } catch { /* ignore */ }
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[secrets] Migration verification failed: ${msg}. Keeping plaintext.`);
      return;
    }

    // Verification passed — delete plaintext
    try { fs.unlinkSync(this.plaintextPath); } catch { /* ignore */ }
    console.log('[secrets] Migrated secrets to encrypted store (secrets.enc)');
  }

  // ── Core read/write ─────────────────────────────────────

  private _load(): Record<string, Record<string, string>> {
    if (this.data && Date.now() - this.cacheTime < SecretsStore.CACHE_TTL_MS) {
      return this.data;
    }

    if (this.encrypted && this.kek) {
      this.data = this._loadEncrypted();
    } else {
      this.data = this._loadPlaintext();
    }

    this.cacheTime = Date.now();
    return this.data;
  }

  private decryptFailed = false;

  private _loadEncrypted(): Record<string, Record<string, string>> {
    try {
      const store = readEncryptedStore(this.encryptedPath);
      if (!store) return {};
      const data = decryptStore(store, this.kek!);
      this.decryptFailed = false;
      return data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[secrets] Failed to decrypt secrets: ${msg}`);
      this.decryptFailed = true;
      return {};
    }
  }

  private _loadPlaintext(): Record<string, Record<string, string>> {
    try {
      if (!fs.existsSync(this.plaintextPath)) return {};
      const raw = fs.readFileSync(this.plaintextPath, 'utf8');
      return JSON.parse(raw) as Record<string, Record<string, string>>;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[secrets] Failed to load plaintext secrets: ${msg}`);
      return {};
    }
  }

  private _save(): void {
    if (this.decryptFailed) {
      console.error('[secrets] Refusing to save — previous decrypt failed. Fix the master key first.');
      return;
    }
    if (this.encrypted && this.kek) {
      this._saveEncrypted();
    } else {
      this._savePlaintext();
    }
    this.cacheTime = Date.now();
  }

  private _saveEncrypted(): void {
    try {
      const store = encryptStore(this.data || {}, this.kek!);
      writeEncryptedStore(this.encryptedPath, store);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[secrets] Failed to save encrypted secrets: ${msg}`);
    }
  }

  private _savePlaintext(): void {
    try {
      const dir = path.dirname(this.plaintextPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.plaintextPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[secrets] Failed to save plaintext secrets: ${msg}`);
    }
  }

  // ── Generic access ──────────────────────────────────────

  /** Get a single secret value. */
  get(namespace: string, key: string): string | undefined {
    const data = this._load();
    return data[namespace]?.[key] ?? undefined;
  }

  /** Get all secrets for a namespace. */
  getAll(namespace: string): Record<string, string> {
    const data = this._load();
    return data[namespace] ? { ...data[namespace] } : {};
  }

  /** Set a single secret value. Empty string deletes the key. */
  set(namespace: string, key: string, value: string): void {
    const data = this._load();
    if (value) {
      if (!data[namespace]) data[namespace] = {};
      data[namespace][key] = value;
    } else {
      if (data[namespace]) {
        delete data[namespace][key];
        if (Object.keys(data[namespace]).length === 0) delete data[namespace];
      }
    }
    this._save();
  }

  /** Set multiple secrets for a namespace. Merges with existing. Empty values delete keys. */
  setAll(namespace: string, values: Record<string, string>): void {
    const data = this._load();
    if (!data[namespace]) data[namespace] = {};
    for (const [k, v] of Object.entries(values)) {
      if (v) data[namespace][k] = v;
      else delete data[namespace][k];
    }
    if (Object.keys(data[namespace]).length === 0) delete data[namespace];
    this._save();
  }

  /** Delete all secrets for a namespace. */
  deleteNamespace(namespace: string): void {
    const data = this._load();
    delete data[namespace];
    this._save();
  }

  /** Check if a key exists (without revealing the value). */
  hasKey(namespace: string, key: string): boolean {
    const data = this._load();
    return data[namespace]?.[key] !== undefined;
  }

  /** List key names for a namespace (no values). */
  listKeys(namespace: string): string[] {
    const data = this._load();
    return Object.keys(data[namespace] || {});
  }

  // ── MCP compatibility methods ───────────────────────────

  getServerSecrets(serverId: string): Record<string, string> {
    return this.getAll(`mcp.${serverId}`);
  }

  setServerSecrets(serverId: string, env: Record<string, string>): void {
    this.setAll(`mcp.${serverId}`, env);
  }

  deleteServerSecrets(serverId: string): void {
    this.deleteNamespace(`mcp.${serverId}`);
  }

  getSetKeys(serverId: string): Record<string, boolean> {
    const keys = this.listKeys(`mcp.${serverId}`);
    const result: Record<string, boolean> = {};
    for (const k of keys) result[k] = true;
    return result;
  }

  /**
   * Resolve env vars for an MCP server.
   * Priority: secrets store > process.env
   * Also resolves ${VAR} references in configEnv values.
   */
  resolveEnv(serverId: string, configEnv: Record<string, string>): Record<string, string> {
    const secrets = this.getServerSecrets(serverId);
    const resolved: Record<string, string> = {};

    for (const [k, v] of Object.entries(configEnv)) {
      if (typeof v === 'string') {
        resolved[k] = v.replace(
          /\$\{([A-Z_][A-Z0-9_]*)\}/g,
          (_, ref: string) => {
            const value = secrets[ref] || process.env[ref] || '';
            if (!value) {
              console.warn(
                `[secrets] resolveEnv(${serverId}): template variable \${${ref}} in key "${k}" could not be resolved`,
              );
            }
            return value;
          },
        );
      } else {
        resolved[k] = v;
      }
    }

    // Overlay secrets — secrets always win
    for (const [k, v] of Object.entries(secrets)) {
      resolved[k] = v;
    }

    return resolved;
  }
}
