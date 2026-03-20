import fs from 'node:fs';
import path from 'node:path';

/**
 * MCP Secrets Store — persists sensitive env vars to a file
 * with restricted permissions instead of storing them in SQLite.
 *
 * File: ~/.agw/mcp-secrets.json (mode 0600)
 * Format: { "serverId": { "KEY": "value", ... }, ... }
 */
export class MCPSecretsStore {
  private filePath: string;
  private cache: Record<string, Record<string, string>> | null = null;
  private cacheTime = 0;
  private static CACHE_TTL_MS = 5000;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'mcp-secrets.json');
  }

  /** Read the secrets file, returning cached data if still within TTL. */
  private _read(): Record<string, Record<string, string>> {
    if (this.cache && Date.now() - this.cacheTime < MCPSecretsStore.CACHE_TTL_MS) {
      return this.cache;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.cache = JSON.parse(raw) as Record<string, Record<string, string>>;
      this.cacheTime = Date.now();
      return this.cache;
    } catch {
      this.cache = {};
      this.cacheTime = Date.now();
      return this.cache;
    }
  }

  /** Write secrets to disk with 0600 permissions. */
  private _write(data: Record<string, Record<string, string>>): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    this.cache = data;
  }

  /** Get all secrets for a server. */
  getServerSecrets(serverId: string): Record<string, string> {
    const data = this._read();
    return data[serverId] ? { ...data[serverId] } : {};
  }

  /** Save/overwrite secrets for a server. Merges with existing. */
  setServerSecrets(serverId: string, env: Record<string, string>): void {
    const data = this._read();
    data[serverId] = { ...(data[serverId] || {}), ...env };
    // Remove keys with empty string values (user clearing a var)
    for (const [k, v] of Object.entries(data[serverId])) {
      if (v === '') delete data[serverId][k];
    }
    this._write(data);
  }

  /** Delete all secrets for a server. */
  deleteServerSecrets(serverId: string): void {
    const data = this._read();
    delete data[serverId];
    this._write(data);
  }

  /** Check which keys are set for a server (without revealing values). */
  getSetKeys(serverId: string): Record<string, boolean> {
    const secrets = this.getServerSecrets(serverId);
    const result: Record<string, boolean> = {};
    for (const key of Object.keys(secrets)) {
      result[key] = true;
    }
    return result;
  }

  /**
   * Resolve env vars for a server.
   * Priority: secrets file > process.env
   * Also resolves ${VAR} references in the dbEnv values.
   */
  resolveEnv(serverId: string, dbEnv: Record<string, string>): Record<string, string> {
    const secrets = this.getServerSecrets(serverId);
    const resolved: Record<string, string> = {};

    // Start with DB env and resolve ${VAR} references
    for (const [k, v] of Object.entries(dbEnv)) {
      if (typeof v === 'string') {
        resolved[k] = v.replace(
          /\$\{([A-Z_][A-Z0-9_]*)\}/g,
          (_, ref: string) => secrets[ref] || process.env[ref] || '',
        );
      } else {
        resolved[k] = v;
      }
    }

    // Overlay secrets — secrets always win over resolved templates
    for (const [k, v] of Object.entries(secrets)) {
      resolved[k] = v;
    }

    return resolved;
  }
}
