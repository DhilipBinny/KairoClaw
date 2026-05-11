/**
 * @agw/plugins — CLI, HTTP, and OpenAPI plugin system.
 *
 * Wraps external shell commands, REST APIs, and OpenAPI services as agent tools.
 * Enterprise products use this to add custom integrations/connectors to their agents.
 */

// Interfaces (injectable dependencies)
export type { PluginToolRegistry, PluginSecretsResolver, PluginMediaStore } from './interfaces.js';

// Plugin registration
export { registerCliPlugins } from './cli.js';
export { registerHttpPlugins } from './http.js';

// OpenAPI auto-import
export { importOpenAPIService, importAllOpenAPIServices, setOpenAPILogger } from './openapi.js';

// Plugin store (persistence)
export { loadPlugins, savePlugins } from './store.js';

// Plugin coordinator (register all + hot-reload)
export { registerAllPlugins, reloadPlugins } from './coordinator.js';

// Media detection utilities (used by HTTP plugins for response processing)
export { detectBase64Image, sniffBase64Mime, extFromContentType } from './media-utils.js';
