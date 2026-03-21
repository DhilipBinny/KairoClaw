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

/**
 * Load plugins configuration from plugins.json.
 * Returns empty config if the file doesn't exist.
 * Validates through the Zod schema.
 */
export function loadPlugins(stateDir: string): PluginsConfig {
  const filePath = path.join(stateDir, PLUGINS_FILENAME);

  if (!fs.existsSync(filePath)) {
    return { cli: [], http: [] };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return pluginsSchema.parse(raw) as unknown as PluginsConfig;
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
