/**
 * manage_http_plugins — LLM-callable tool to discover, test, and configure HTTP API plugins.
 *
 * Actions:
 *   test   — probe any URL, return raw status/headers/body
 *   add    — save a fully structured HTTP plugin to config.json + hot-reload
 *   list   — show current HTTP plugins
 *   update — modify an existing plugin
 *   remove — delete a plugin
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistration } from '../types.js';
import type { MediaStore } from '../../media/store.js';
import { detectBase64Image, extFromContentType } from '../../media/store.js';
import type { PluginsConfig } from '@agw/types';

const PLUGINS_FILENAME = 'plugins.json';

/** Read plugins.json from disk. */
function readPluginsFile(stateDir: string): PluginsConfig {
  const filePath = path.join(stateDir, PLUGINS_FILENAME);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PluginsConfig;
    }
  } catch { /* fall through */ }
  return { cli: [], http: [] };
}

/** Write plugins.json to disk. */
function writePluginsFile(stateDir: string, plugins: PluginsConfig): void {
  const filePath = path.join(stateDir, PLUGINS_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(plugins, null, 2), { mode: 0o600 });
}

const MAX_RESPONSE_SIZE = 10 * 1024;

export const pluginTools: ToolRegistration[] = [
  {
    definition: {
      name: 'manage_http_plugins',
      description: `Manage HTTP API plugins. Discover, test, and register external REST APIs as tools the agent can use.

Workflow to add a new API:
1. Use action="test" to probe the API (try /health, /openapi.json, etc.)
2. Ask the user about endpoints, parameters, and auth requirements
3. Test each endpoint with action="test" to confirm it works
4. Use action="add" to save the full plugin configuration

The "test" action is a general-purpose HTTP probe — use it to explore any URL.
The "add" action saves a structured plugin config and immediately registers the tools.

Auth: if the API needs authentication, ask the user for the type (bearer/header/query/basic) and the secret. The secret is stored securely in the secrets store, never in config.json.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['test', 'add', 'list', 'update', 'remove'],
            description: 'Action to perform',
          },
          // --- test action params ---
          url: { type: 'string', description: 'Full URL to probe (for "test" action)' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (for "test", default: GET)' },
          headers: {
            type: 'object',
            description: 'Request headers (for "test")',
          },
          body: {
            type: 'object',
            description: 'Request body as JSON (for "test" with POST/PUT/PATCH)',
          },
          timeout: { type: 'number', description: 'Request timeout in seconds (for "test", default: 15, max: 600). Use higher values for slow endpoints like image generation (e.g. 180 for 3 min).' },
          // --- add/update action params ---
          plugin: {
            type: 'object',
            description: 'Full plugin config (for "add" or "update"). Structure: { name, baseUrl, description, enabled, timeout, endpoints: [{ name, method, path, description, parameters: { paramName: { type, description, required, default } } }] }',
            properties: {
              name: { type: 'string', description: 'Unique plugin name (lowercase alphanumeric + underscores)' },
              baseUrl: { type: 'string', description: 'Base URL for the API' },
              description: { type: 'string', description: 'Human-readable description' },
              enabled: { type: 'boolean', description: 'Whether the plugin is enabled (default: true)' },
              timeout: { type: 'number', description: 'Request timeout in seconds (default: 30, max: 120)' },
              endpoints: {
                type: 'array',
                description: 'API endpoints to register as tools',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Endpoint name (lowercase, used in tool name)' },
                    method: { type: 'string', description: 'HTTP method' },
                    path: { type: 'string', description: 'URL path relative to baseUrl' },
                    description: { type: 'string' },
                    parameters: { type: 'object', description: 'Parameter definitions: { paramName: { type, description, required, default } }' },
                  },
                },
              },
            },
          },
          // --- auth config (for add/update) ---
          auth: {
            type: 'object',
            description: 'Auth config (for "add"/"update"). { type: "bearer"|"header"|"query"|"basic", headerName?: string, queryParam?: string }',
            properties: {
              type: { type: 'string', enum: ['bearer', 'header', 'query', 'basic'] },
              headerName: { type: 'string', description: 'Header name for "header" auth type' },
              queryParam: { type: 'string', description: 'Query param name for "query" auth type' },
            },
          },
          authSecret: { type: 'string', description: 'Auth token/key value to store in secrets (for "add"/"update"). Stored securely, never in config.json.' },
          // --- remove action params ---
          name: { type: 'string', description: 'Plugin name (for "remove" or "update")' },
        },
        required: ['action'],
      },
    },
    executor: async (args, context) => {
      const action = args.action as string;
      if (!action) return { error: 'action is required' };

      const ctx = context as Record<string, unknown>;
      const config = ctx.config as Record<string, unknown>;
      const secretsStore = ctx.secretsStore as {
        get: (ns: string, key: string) => string | undefined;
        set: (ns: string, key: string, value: string) => void;
        deleteNamespace: (ns: string) => void;
      } | undefined;

      switch (action) {
        // ─── TEST ─────────────────────────────────────
        case 'test': {
          const url = args.url as string;
          if (!url) return { error: 'url is required for test action' };

          const method = (args.method as string || 'GET').toUpperCase();
          const headers = (args.headers || {}) as Record<string, string>;
          const body = args.body as Record<string, unknown> | undefined;
          const timeoutSec = Math.min(Math.max((args.timeout as number) || 15, 1), 600);

          // Basic SSRF protection
          try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
              return { error: `Blocked: only http/https allowed, got ${parsed.protocol}` };
            }
            const hostname = parsed.hostname.toLowerCase();
            // Block cloud metadata
            if (['metadata.google.internal', 'metadata.google.com'].includes(hostname) ||
                hostname === 'instance-data' ||
                (hostname.match(/^169\.254\./) !== null)) {
              return { error: 'Blocked: cloud metadata endpoint' };
            }
          } catch {
            return { error: 'Invalid URL' };
          }

          try {
            const fetchOpts: RequestInit = {
              method,
              headers: { 'User-Agent': 'Kairo/2.0', ...headers },
              signal: AbortSignal.timeout(timeoutSec * 1000),
            };

            if (['POST', 'PUT', 'PATCH'].includes(method) && body) {
              fetchOpts.headers = { ...fetchOpts.headers as Record<string, string>, 'Content-Type': 'application/json' };
              fetchOpts.body = JSON.stringify(body);
            }

            const res = await fetch(url, fetchOpts);

            // Read response
            const contentType = res.headers.get('content-type') || '';
            const media = ctx.mediaStore as MediaStore | undefined;
            let responseBody: unknown;

            // Binary image response — save to media store
            const imgExt = extFromContentType(contentType);
            if (imgExt && media) {
              const buf = Buffer.from(await res.arrayBuffer());
              const filename = media.save(buf, imgExt);
              const mediaUrl = media.getUrl(filename);
              return {
                status: res.status,
                statusText: res.statusText,
                contentType,
                mediaUrl,
                sizeBytes: buf.length,
                note: `Image saved. Use markdown to show: ![image](${mediaUrl})`,
              };
            } else if (imgExt) {
              const buf = await res.arrayBuffer();
              responseBody = `[Binary image: ${contentType}, ${buf.byteLength} bytes — media store not available]`;
            } else if (contentType.includes('application/json')) {
              try {
                responseBody = await res.json();
                // Scan for base64 images in JSON fields
                if (media && responseBody && typeof responseBody === 'object' && !Array.isArray(responseBody)) {
                  const obj = responseBody as Record<string, unknown>;
                  for (const [key, val] of Object.entries(obj)) {
                    if (typeof val !== 'string') continue;
                    const detected = detectBase64Image(val);
                    if (detected) {
                      const filename = media.saveBase64(val, detected.ext);
                      const mediaUrl = media.getUrl(filename);
                      obj[key] = mediaUrl;
                      obj[`${key}_note`] = `Image saved. Use markdown: ![image](${mediaUrl})`;
                    }
                  }
                }
              } catch {
                responseBody = await res.text();
              }
            } else {
              responseBody = await res.text();
            }

            // Truncate
            const bodyStr = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody, null, 2);
            const truncated = bodyStr.length > MAX_RESPONSE_SIZE
              ? bodyStr.slice(0, MAX_RESPONSE_SIZE) + '\n... (truncated)'
              : bodyStr;

            return {
              status: res.status,
              statusText: res.statusText,
              contentType,
              body: truncated,
            };
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return { error: `Request failed: ${msg}` };
          }
        }

        // ─── LIST ─────────────────────────────────────
        case 'list': {
          const plugins = ((config as Record<string, unknown>).plugins as Record<string, unknown>)?.http as Array<Record<string, unknown>> || [];
          return {
            count: plugins.length,
            plugins: plugins.map(p => ({
              name: p.name,
              baseUrl: p.baseUrl,
              description: p.description,
              enabled: p.enabled,
              timeout: p.timeout,
              endpointCount: (p.endpoints as unknown[])?.length || 0,
              endpoints: ((p.endpoints as Array<Record<string, unknown>>) || []).map(e => ({
                name: e.name,
                method: e.method,
                path: e.path,
                description: e.description,
              })),
              hasAuth: !!(p.auth as Record<string, unknown>)?.type,
            })),
          };
        }

        // ─── ADD ──────────────────────────────────────
        case 'add': {
          const pluginData = args.plugin as Record<string, unknown> | undefined;
          if (!pluginData) return { error: 'plugin object is required for add action' };

          const name = pluginData.name as string;
          if (!name) return { error: 'plugin.name is required' };
          if (!/^[a-z0-9_]+$/.test(name)) return { error: 'plugin.name must be lowercase alphanumeric + underscores' };

          const baseUrl = pluginData.baseUrl as string;
          if (!baseUrl) return { error: 'plugin.baseUrl is required' };

          const endpoints = pluginData.endpoints as Array<Record<string, unknown>> | undefined;
          if (!endpoints || endpoints.length === 0) return { error: 'plugin.endpoints is required (at least one endpoint)' };

          // Validate endpoint names
          for (const ep of endpoints) {
            if (!ep.name || !/^[a-z0-9_]+$/.test(ep.name as string)) {
              return { error: `Endpoint name "${ep.name}" must be lowercase alphanumeric + underscores` };
            }
          }

          // Build the plugin config object
          const pluginConfig: Record<string, unknown> = {
            name,
            baseUrl,
            description: pluginData.description || '',
            enabled: pluginData.enabled !== false,
            timeout: Math.min(Math.max((pluginData.timeout as number) || 30, 1), 600),
            endpoints: endpoints.map(ep => ({
              name: ep.name,
              method: (ep.method as string || 'GET').toUpperCase(),
              path: ep.path || '/',
              description: ep.description || '',
              parameters: ep.parameters || {},
            })),
          };

          // Handle auth
          const authConfig = args.auth as Record<string, unknown> | undefined;
          const authSecret = args.authSecret as string | undefined;

          if (authConfig?.type) {
            const secretNamespace = `plugins.${name}`;
            pluginConfig.auth = {
              type: authConfig.type,
              tokenSecret: secretNamespace,
              ...(authConfig.headerName ? { headerName: authConfig.headerName } : {}),
              ...(authConfig.queryParam ? { queryParam: authConfig.queryParam } : {}),
            };

            // Store the secret
            if (authSecret && secretsStore) {
              secretsStore.set(secretNamespace, 'token', authSecret);
            }
          }

          // Read plugins.json
          const stateDir = (config as Record<string, unknown>)._stateDir as string || '';
          const pluginsData = readPluginsFile(stateDir);

          // Check for duplicate name
          if (pluginsData.http.some(p => p.name === name)) {
            return { error: `Plugin "${name}" already exists. Use action="update" to modify it, or action="remove" to delete it first.` };
          }

          pluginsData.http.push(pluginConfig as any);

          // Write plugins.json
          try {
            writePluginsFile(stateDir, pluginsData);
          } catch {
            return { error: 'Failed to write plugins file' };
          }

          // Update runtime config
          (config as Record<string, unknown>).plugins = pluginsData;

          // Trigger hot-reload
          const reloader = ctx.pluginReloader as (() => string[]) | undefined;
          let registeredTools: string[] = [];
          if (reloader) {
            registeredTools = reloader();
          }

          return {
            success: true,
            plugin: name,
            endpoints: (pluginConfig.endpoints as Array<Record<string, unknown>>).map(e => `http_${name}_${e.name}`),
            totalPluginTools: registeredTools.length,
          };
        }

        // ─── UPDATE ───────────────────────────────────
        case 'update': {
          const pluginName = (args.name || (args.plugin as Record<string, unknown>)?.name) as string;
          if (!pluginName) return { error: 'name is required for update action' };

          const stateDir = (config as Record<string, unknown>)._stateDir as string || '';
          const pluginsData = readPluginsFile(stateDir);

          const idx = pluginsData.http.findIndex(p => p.name === pluginName);
          if (idx < 0) return { error: `Plugin "${pluginName}" not found` };

          // Merge updates
          const updates = args.plugin as Record<string, unknown> | undefined;
          if (updates) {
            const target = pluginsData.http[idx] as unknown as Record<string, unknown>;
            if (updates.baseUrl) target.baseUrl = updates.baseUrl;
            if (updates.description !== undefined) target.description = updates.description;
            if (updates.enabled !== undefined) target.enabled = updates.enabled;
            if (updates.timeout !== undefined) target.timeout = Math.min(Math.max(updates.timeout as number, 1), 600);
            if (updates.endpoints) target.endpoints = (updates.endpoints as Array<Record<string, unknown>>).map(ep => ({
              name: ep.name,
              method: (ep.method as string || 'GET').toUpperCase(),
              path: ep.path || '/',
              description: ep.description || '',
              parameters: ep.parameters || {},
            }));
          }

          // Handle auth update
          const authConfig = args.auth as Record<string, unknown> | undefined;
          const authSecret = args.authSecret as string | undefined;
          if (authConfig?.type) {
            const secretNamespace = `plugins.${pluginName}`;
            (pluginsData.http[idx] as unknown as Record<string, unknown>).auth = {
              type: authConfig.type,
              tokenSecret: secretNamespace,
              ...(authConfig.headerName ? { headerName: authConfig.headerName } : {}),
              ...(authConfig.queryParam ? { queryParam: authConfig.queryParam } : {}),
            };
            if (authSecret && secretsStore) {
              secretsStore.set(secretNamespace, 'token', authSecret);
            }
          }

          // Write plugins.json
          try {
            writePluginsFile(stateDir, pluginsData);
          } catch {
            return { error: 'Failed to write plugins file' };
          }

          // Update runtime config
          (config as Record<string, unknown>).plugins = pluginsData;

          // Trigger hot-reload
          const reloader = ctx.pluginReloader as (() => string[]) | undefined;
          if (reloader) reloader();

          return { success: true, plugin: pluginName };
        }

        // ─── REMOVE ───────────────────────────────────
        case 'remove': {
          const pluginName = args.name as string;
          if (!pluginName) return { error: 'name is required for remove action' };

          const stateDir = (config as Record<string, unknown>)._stateDir as string || '';
          const pluginsData = readPluginsFile(stateDir);

          const idx = pluginsData.http.findIndex(p => p.name === pluginName);
          if (idx < 0) return { error: `Plugin "${pluginName}" not found` };

          pluginsData.http.splice(idx, 1);

          // Write plugins.json
          try {
            writePluginsFile(stateDir, pluginsData);
          } catch {
            return { error: 'Failed to write plugins file' };
          }

          // Update runtime config
          (config as Record<string, unknown>).plugins = pluginsData;

          // Clean up secrets
          if (secretsStore) {
            try {
              secretsStore.deleteNamespace(`plugins.${pluginName}`);
            } catch { /* non-fatal */ }
          }

          // Trigger hot-reload
          const reloader = ctx.pluginReloader as (() => string[]) | undefined;
          if (reloader) reloader();

          return { success: true, removed: pluginName };
        }

        default:
          return { error: `Unknown action: ${action}. Use: test, add, list, update, remove` };
      }
    },
    source: 'builtin',
    category: 'execute',
  },
];
