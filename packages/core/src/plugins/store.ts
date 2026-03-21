/**
 * Plugins Store — manages plugins.json as a separate config file.
 *
 * File: ~/.agw/plugins.json
 *
 * Format:
 * {
 *   "cli": [ { name, command, description, enabled, timeout, ... } ],
 *   "http": [ { name, baseUrl, description, enabled, timeout, endpoints, ... } ]
 * }
 *
 * Separation from config.json:
 *   - Plugins change frequently (LLM adds/removes APIs)
 *   - Isolates plugin writes from core config (no risk of corruption)
 *   - Easier to backup/share plugin configurations
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PluginsConfig } from '@agw/types';
import { pluginsSchema } from '../config/schema.js';

const PLUGINS_FILENAME = 'plugins.json';

/** Default plugins seeded on first run. */
const DEFAULT_PLUGINS: PluginsConfig = {
  cli: [
    {
      name: 'date',
      command: 'date',
      description: 'Get the current date, time, and timezone. Supports format strings (e.g. "+%Y-%m-%d", "+%A %B %d %Y %H:%M:%S %Z").',
      enabled: true,
      timeout: 5,
      allowedSubcommands: [],
      blockedSubcommands: [],
      requireConfirmation: [],
    },
    {
      name: 'cal',
      command: 'cal',
      description: 'Show a calendar. Use "-3" for 3-month view, "-y" for full year, or a specific month/year (e.g. "3 2026").',
      enabled: true,
      timeout: 5,
      allowedSubcommands: [],
      blockedSubcommands: [],
      requireConfirmation: [],
    },
    {
      name: 'jq',
      command: 'jq',
      description: 'Process and transform JSON data. Pass a jq filter expression as args. Pipe input via echo or use with files.',
      enabled: true,
      timeout: 10,
      allowedSubcommands: [],
      blockedSubcommands: [],
      requireConfirmation: [],
    },
    {
      name: 'gh',
      command: 'gh',
      description: 'GitHub CLI — manage PRs, issues, repos, and workflows. Requires "gh auth login" first. Enable this plugin after authenticating.',
      enabled: false,
      timeout: 30,
      allowedSubcommands: ['pr', 'issue', 'repo', 'run', 'release', 'search', 'api', 'status'],
      blockedSubcommands: ['auth', 'ssh-key', 'gpg-key', 'secret'],
      requireConfirmation: ['pr merge', 'pr close', 'issue close', 'repo delete', 'release delete'],
      env: ['GITHUB_TOKEN'],
    },
  ],
  http: [
    {
      name: 'currency',
      baseUrl: 'https://api.frankfurter.dev/v1',
      description: 'Currency exchange rates — no API key required (Frankfurter)',
      enabled: true,
      timeout: 10,
      endpoints: [
        {
          name: 'latest',
          method: 'GET',
          path: '/latest',
          description: 'Get latest exchange rates. Base defaults to EUR if omitted.',
          parameters: {
            base: { type: 'string', description: 'Base currency code (e.g. USD, EUR, SGD)' },
            symbols: { type: 'string', description: 'Comma-separated target currencies (e.g. EUR,GBP,INR)' },
          },
        },
        {
          name: 'currencies',
          method: 'GET',
          path: '/currencies',
          description: 'List all supported currency codes and their full names.',
          parameters: {},
        },
      ],
    },
  ],
};

/**
 * Merge default plugins into an existing config.
 * Tracks which defaults have been offered in `_seededDefaults` so that
 * if a user removes one, it won't be re-added on next startup.
 * Returns true if plugins.json needs to be re-saved.
 */
function mergeDefaults(config: PluginsConfig): boolean {
  const prev = new Set((config as any)._seededDefaults as string[] || []);
  const seeded = new Set(prev);
  const existingCliNames = new Set(config.cli.map(p => p.name));
  const existingHttpNames = new Set(config.http.map(p => p.name));
  let changed = false;

  for (const def of DEFAULT_PLUGINS.cli) {
    const key = `cli:${def.name}`;
    if (!seeded.has(key)) {
      seeded.add(key);
      changed = true;
      if (!existingCliNames.has(def.name)) {
        config.cli.push(def);
      }
    }
  }
  for (const def of DEFAULT_PLUGINS.http) {
    const key = `http:${def.name}`;
    if (!seeded.has(key)) {
      seeded.add(key);
      changed = true;
      if (!existingHttpNames.has(def.name)) {
        config.http.push(def);
      }
    }
  }

  if (changed) {
    (config as any)._seededDefaults = [...seeded];
  }
  return changed;
}

/**
 * Load plugins configuration from plugins.json.
 * Seeds missing default plugins on every load (never overrides existing).
 * Validates through the Zod schema.
 */
export function loadPlugins(stateDir: string): PluginsConfig {
  const filePath = path.join(stateDir, PLUGINS_FILENAME);

  if (!fs.existsSync(filePath)) {
    // First run — seed with defaults and mark all as seeded
    const seeded = [
      ...DEFAULT_PLUGINS.cli.map(p => `cli:${p.name}`),
      ...DEFAULT_PLUGINS.http.map(p => `http:${p.name}`),
    ];
    const initial = { ...DEFAULT_PLUGINS, _seededDefaults: seeded } as PluginsConfig;
    savePlugins(stateDir, initial);
    return initial;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const config = pluginsSchema.parse(raw) as unknown as PluginsConfig;

    // Merge in any new defaults that don't exist yet (e.g. after upgrade)
    if (mergeDefaults(config)) {
      savePlugins(stateDir, config);
    }

    return config;
  } catch (e) {
    console.error(`[plugins] Failed to parse ${filePath}: ${(e as Error).message}`);
    console.error('[plugins] Falling back to empty plugins config');
    return { cli: [], http: [] };
  }
}

/**
 * Save plugins configuration to plugins.json.
 */
export function savePlugins(stateDir: string, config: PluginsConfig): void {
  const filePath = path.join(stateDir, PLUGINS_FILENAME);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
}
