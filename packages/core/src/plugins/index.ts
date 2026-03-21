/**
 * Plugin Coordinator — unified registration and hot-reload for all plugin types.
 */

import type { GatewayConfig } from '@agw/types';
import type { ToolRegistry } from '../tools/registry.js';
import type { SecretsStore } from '../secrets/store.js';
import type { MediaStore } from '../media/store.js';
import type { Logger } from 'pino';
import { registerCliPlugins } from './cli.js';
import { registerHttpPlugins } from './http.js';

/** Track registered plugin tool names for cleanup during reload. */
let registeredPluginTools: string[] = [];

/**
 * Register all enabled plugins (CLI + HTTP) into the tool registry.
 * Returns the list of all registered plugin tool names.
 */
export function registerAllPlugins(
  config: GatewayConfig,
  toolRegistry: ToolRegistry,
  secretsStore: SecretsStore,
  logger: Logger,
  mediaStore?: MediaStore,
): string[] {
  const cliTools = registerCliPlugins(config, toolRegistry, logger);
  const httpTools = registerHttpPlugins(config, toolRegistry, secretsStore, logger, mediaStore);
  registeredPluginTools = [...cliTools, ...httpTools];
  return registeredPluginTools;
}

/**
 * Hot-reload plugins: unregister all existing plugin tools, then re-register
 * from current config. Used when plugin config changes via admin API.
 */
export function reloadPlugins(
  config: GatewayConfig,
  toolRegistry: ToolRegistry,
  secretsStore: SecretsStore,
  logger: Logger,
  mediaStore?: MediaStore,
): string[] {
  // Unregister all previously registered plugin tools
  for (const name of registeredPluginTools) {
    toolRegistry.unregister(name);
  }
  logger.info({ count: registeredPluginTools.length }, 'Unregistered previous plugin tools');

  // Re-register from current config
  return registerAllPlugins(config, toolRegistry, secretsStore, logger, mediaStore);
}
