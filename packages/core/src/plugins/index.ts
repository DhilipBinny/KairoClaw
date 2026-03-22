/**
 * Plugin Coordinator — unified registration and hot-reload for all plugin types.
 *
 * Supports:
 *   - CLI plugins (wrap shell commands)
 *   - HTTP plugins (wrap REST APIs)
 *   - OpenAPI auto-import (fetch /openapi.json, auto-create HTTP plugins)
 */

import type { GatewayConfig } from '@agw/types';
import type { ToolRegistry } from '../tools/registry.js';
import type { SecretsStore } from '../secrets/store.js';
import type { MediaStore } from '../media/store.js';
import type { Logger } from 'pino';
import { registerCliPlugins } from './cli.js';
import { registerHttpPlugins } from './http.js';
import { importAllOpenAPIServices } from './openapi.js';

/** Track registered plugin tool names for cleanup during reload. */
let registeredPluginTools: string[] = [];

/**
 * Run OpenAPI auto-import: fetch specs from configured services and
 * merge discovered endpoints into the config's HTTP plugins list.
 * Mutates config.plugins.http in-place (adds/updates discovered plugins).
 */
async function runOpenAPIImport(config: GatewayConfig, logger: Logger): Promise<void> {
  const services = (config.plugins as unknown as Record<string, unknown>)?.openapi as Array<{ name: string; baseUrl: string; enabled?: boolean; description?: string; timeout?: number; skipPaths?: string[] }> | undefined;
  if (!services || services.length === 0) return;

  const enabledServices = services.filter((s: { enabled?: boolean }) => s.enabled !== false);
  if (enabledServices.length === 0) return;

  logger.info({ count: enabledServices.length }, 'Auto-importing OpenAPI services');

  const { plugins: merged, imported, errors } = await importAllOpenAPIServices(
    enabledServices,
    config.plugins?.http || [],
  );

  // Update config in-place
  if (!config.plugins) config.plugins = { cli: [], http: [] };
  config.plugins.http = merged;

  if (imported.length > 0) {
    logger.info({ imported }, 'OpenAPI services imported successfully');
  }
  for (const err of errors) {
    logger.warn({ service: err.name, error: err.error }, 'OpenAPI import failed');
  }
}

/**
 * Register all enabled plugins (CLI + HTTP + OpenAPI) into the tool registry.
 * Returns the list of all registered plugin tool names.
 */
export async function registerAllPlugins(
  config: GatewayConfig,
  toolRegistry: ToolRegistry,
  secretsStore: SecretsStore,
  logger: Logger,
  mediaStore?: MediaStore,
): Promise<string[]> {
  // Auto-import OpenAPI services before registering HTTP plugins
  await runOpenAPIImport(config, logger);

  const cliTools = registerCliPlugins(config, toolRegistry, logger);
  const httpTools = registerHttpPlugins(config, toolRegistry, secretsStore, logger, mediaStore);
  registeredPluginTools = [...cliTools, ...httpTools];
  return registeredPluginTools;
}

/**
 * Hot-reload plugins: unregister all existing plugin tools, then re-register
 * from current config. Used when plugin config changes via admin API.
 */
export async function reloadPlugins(
  config: GatewayConfig,
  toolRegistry: ToolRegistry,
  secretsStore: SecretsStore,
  logger: Logger,
  mediaStore?: MediaStore,
): Promise<string[]> {
  // Unregister all previously registered plugin tools
  for (const name of registeredPluginTools) {
    toolRegistry.unregister(name);
  }
  logger.info({ count: registeredPluginTools.length }, 'Unregistered previous plugin tools');

  // Re-register from current config
  return registerAllPlugins(config, toolRegistry, secretsStore, logger, mediaStore);
}
