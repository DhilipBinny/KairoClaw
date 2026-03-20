/**
 * Migration: .env + mcp-secrets.json → unified secrets.json
 *
 * Reads secrets from legacy sources and populates the unified store.
 * Idempotent — skips if secrets.json already exists and has data.
 * Does NOT delete original files (backward compat).
 */

import fs from 'node:fs';
import path from 'node:path';
import { SecretsStore } from './store.js';

/** Env var → secrets store mapping. */
const ENV_TO_SECRETS: Array<{ envKey: string; namespace: string; secretKey: string }> = [
  { envKey: 'ANTHROPIC_API_KEY', namespace: 'providers.anthropic', secretKey: 'apiKey' },
  { envKey: 'ANTHROPIC_AUTH_TOKEN', namespace: 'providers.anthropic', secretKey: 'authToken' },
  { envKey: 'ANTHROPIC_BASE_URL', namespace: 'providers.anthropic', secretKey: 'baseUrl' },
  { envKey: 'OPENAI_API_KEY', namespace: 'providers.openai', secretKey: 'apiKey' },
  { envKey: 'OLLAMA_BASE_URL', namespace: 'providers.ollama', secretKey: 'baseUrl' },
  { envKey: 'TELEGRAM_BOT_TOKEN', namespace: 'channels.telegram', secretKey: 'botToken' },
  { envKey: 'BRAVE_API_KEY', namespace: 'tools.webSearch', secretKey: 'apiKey' },
  { envKey: 'AGW_TOKEN', namespace: 'gateway', secretKey: 'token' },
];

/**
 * Migrate secrets from .env + mcp-secrets.json into the unified secrets.json.
 * Returns the number of secrets migrated.
 */
export function migrateToSecretsStore(stateDir: string): number {
  const store = new SecretsStore(stateDir);
  const secretsPath = path.join(stateDir, 'secrets.json');
  let migrated = 0;

  // Skip if secrets.json already has data
  try {
    if (fs.existsSync(secretsPath)) {
      const existing = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
      if (existing && Object.keys(existing).length > 0) {
        return 0; // already migrated
      }
    }
  } catch { /* proceed with migration */ }

  // Pre-create secrets file with restrictive permissions before writing any content
  fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
  fs.writeFileSync(secretsPath, '', { mode: 0o600 });

  // 1. Migrate from .env (via process.env, since dotenv already loaded it)
  for (const { envKey, namespace, secretKey } of ENV_TO_SECRETS) {
    const value = process.env[envKey];
    if (value) {
      store.set(namespace, secretKey, value);
      migrated++;
    }
  }

  // 2. Also parse .env file directly for values not in process.env
  const envPath = path.join(stateDir, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!value) continue;

        const mapping = ENV_TO_SECRETS.find(m => m.envKey === key);
        if (mapping && !store.hasKey(mapping.namespace, mapping.secretKey)) {
          store.set(mapping.namespace, mapping.secretKey, value);
          migrated++;
        }
      }
    } catch { /* non-fatal */ }
  }

  // 3. Migrate MCP secrets from mcp-secrets.json
  const mcpSecretsPath = path.join(stateDir, 'mcp-secrets.json');
  if (fs.existsSync(mcpSecretsPath)) {
    try {
      const mcpSecrets = JSON.parse(fs.readFileSync(mcpSecretsPath, 'utf8')) as Record<string, Record<string, string>>;
      for (const [serverId, secrets] of Object.entries(mcpSecrets)) {
        if (secrets && typeof secrets === 'object') {
          store.setAll(`mcp.${serverId}`, secrets);
          migrated += Object.keys(secrets).length;
        }
      }
    } catch { /* non-fatal */ }
  }

  if (migrated > 0) {
    console.log(`[secrets] Migrated ${migrated} secrets to secrets.json`);
  }

  return migrated;
}
