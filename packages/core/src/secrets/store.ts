/**
 * Unified Secrets Store — single source of truth for ALL secrets.
 *
 * File: ~/.agw/secrets.json (mode 0600)
 *
 * Format: flat two-level namespaced structure:
 * {
 *   "providers.anthropic": { "apiKey": "sk-...", "authToken": "" },
 *   "providers.openai":    { "apiKey": "sk-..." },
 *   "providers.ollama":    { "baseUrl": "http://..." },
 *   "channels.telegram":   { "botToken": "123:ABC" },
 *   "tools.webSearch":     { "apiKey": "BSA..." },
 *   "gateway":             { "token": "agw_sk_..." },
 *   "mcp.github":          { "GITHUB_TOKEN": "ghp_..." }
 * }
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

export class SecretsStore {
  private filePath: string;
  private data: Record<string, Record<string, string>> | null = null;
  private cacheTime = 0;
  private static CACHE_TTL_MS = 5000;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'secrets.json');
  }

  // ── Core read/write ─────────────────────────────────

  private _load(): Record<string, Record<string, string>> {
    if (this.data && Date.now() - this.cacheTime < SecretsStore.CACHE_TTL_MS) {
      return this.data;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.data = JSON.parse(raw) as Record<string, Record<string, string>>;
    } catch {
      this.data = {};
    }
    this.cacheTime = Date.now();
    return this.data;
  }

  private _save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    this.cacheTime = Date.now();
  }

  // ── Generic access ──────────────────────────────────

  /** Get a single secret value. */
  get(namespace: string, key: string): string | undefined {
    const data = this._load();
    return data[namespace]?.[key] || undefined;
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
    return !!data[namespace]?.[key];
  }

  /** List key names for a namespace (no values). */
  listKeys(namespace: string): string[] {
    const data = this._load();
    return Object.keys(data[namespace] || {});
  }

  // ── MCP compatibility methods ───────────────────────
  // These match the MCPSecretsStore API so the MCP bridge
  // can use SecretsStore as a drop-in replacement.

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
          (_, ref: string) => secrets[ref] || process.env[ref] || '',
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
