import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';
import type { GatewayConfig } from '@agw/types';
import { configDefaults, parseConfig } from './schema.js';

// ──────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────

export const STATE_DIR = process.env.AGW_STATE_DIR || path.join(os.homedir(), '.agw');
export const CONFIG_PATH = process.env.AGW_CONFIG || path.join(STATE_DIR, 'config.json');

// ──────────────────────────────────────────────
// Load .env files (same locations as v1)
// ──────────────────────────────────────────────

// Load from state dir first (agw-data/.env), then CWD
const envPaths = [
  path.join(STATE_DIR, '.env'),
  path.join(process.cwd(), '.env'),
];
for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

// ──────────────────────────────────────────────
// Environment variable substitution
// ──────────────────────────────────────────────

const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/;

/**
 * Resolve `${VAR}` references in config values.
 * Missing env vars resolve to empty string.
 */
export function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    if (ENV_VAR_PATTERN.test(obj)) {
      return obj.replace(new RegExp(ENV_VAR_PATTERN.source, 'g'), (_, key: string) => {
        if (!process.env[key]) console.warn(`[config] Warning: \${${key}} not found in environment`);
        return process.env[key] || '';
      });
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => resolveEnvVars(v));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = resolveEnvVars(v);
    }
    return out;
  }
  return obj;
}

// ──────────────────────────────────────────────
// Deep merge (with prototype pollution protection)
// ──────────────────────────────────────────────

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (BLOCKED_KEYS.has(key)) continue;
    const sourceVal = source[key];
    const targetVal = target[key];
    if (
      sourceVal &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      out[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      out[key] = sourceVal;
    }
  }
  return out;
}

// ──────────────────────────────────────────────
// Load config
// ──────────────────────────────────────────────

/**
 * Load gateway configuration from a JSON file.
 * - Creates default config if the file doesn't exist
 * - Merges user config with defaults (auto-migration of new fields)
 * - Resolves `${VAR}` environment variable references
 */
export function loadConfig(configPath?: string): GatewayConfig {
  const cfgPath = configPath || CONFIG_PATH;
  const stateDir = path.dirname(cfgPath);

  // Ensure state directory exists
  fs.mkdirSync(stateDir, { recursive: true });

  // First run: seed config.json with defaults
  if (!fs.existsSync(cfgPath)) {
    console.log(`[config] First run — creating ${cfgPath}`);
    const initial = JSON.stringify(configDefaults, null, 2);
    fs.writeFileSync(cfgPath, initial, { mode: 0o600 });
  }

  // Read config.json
  let rawConfig: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    rawConfig = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    console.error(`[config] Failed to parse ${cfgPath}: ${(e as Error).message}`);
    console.error(`[config] Falling back to defaults`);
    rawConfig = { ...configDefaults } as unknown as Record<string, unknown>;
  }

  // One-time migrations for field type changes
  // v1: showModelIndicator changed from boolean → 'off'|'admin_only'|'all'
  const smi = (rawConfig as any)?.agent?.showModelIndicator;
  if (smi && typeof smi === 'object') {
    for (const ch of ['telegram', 'whatsapp', 'web'] as const) {
      if (typeof smi[ch] === 'boolean') {
        smi[ch] = smi[ch] ? 'all' : 'off';
      }
    }
  }

  // v2: models.catalog renamed to models.capabilities
  const modelsSection = (rawConfig as any)?.models;
  if (modelsSection?.catalog && !modelsSection.capabilities) {
    modelsSection.capabilities = modelsSection.catalog;
    delete modelsSection.catalog;
  }

  // Migrate: add new fields from defaults that don't exist yet
  const migrated = deepMerge(
    configDefaults as unknown as Record<string, unknown>,
    rawConfig,
  );

  // Write back if migration added new fields
  if (JSON.stringify(migrated) !== JSON.stringify(rawConfig)) {
    try {
      fs.writeFileSync(cfgPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
      console.log(`[config] Migrated config with new fields`);
    } catch {
      /* non-fatal */
    }
  }

  // Resolve ${VAR} references
  const resolved = resolveEnvVars(migrated) as Record<string, unknown>;

  // Validate through Zod
  const config = parseConfig(resolved);

  // Set internal state dir
  config._stateDir = stateDir;

  return config;
}
