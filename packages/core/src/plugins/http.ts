/**
 * HTTP Plugin Module — registers HTTP API tools into the ToolRegistry.
 *
 * Each enabled HTTP plugin creates one tool per endpoint:
 * `http_{pluginName}_{endpointName}`.
 */

import type { GatewayConfig, HttpPluginConfig, HttpEndpointConfig } from '@agw/types';

type EndpointParamDef = { type: string; description?: string; required?: boolean; default?: unknown };
import type { ToolRegistration } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SecretsStore } from '../secrets/store.js';
import type { MediaStore } from '../media/store.js';
import { detectBase64Image, extFromContentType } from '../media/store.js';
import type { Logger } from 'pino';

/** Max response size returned to the LLM. */
const MAX_RESPONSE_SIZE = 10 * 1024;

/**
 * Validate a URL for HTTP plugins.
 * Admin explicitly configured these URLs, so private IPs are allowed.
 * Only block metadata endpoints and loopback.
 */
function validatePluginUrl(urlStr: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked URL scheme: ${parsed.protocol} — only http/https allowed`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block loopback only (private IPs are intentionally allowed for HTTP plugins)
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) {
    throw new Error('Blocked: localhost/loopback URLs not allowed');
  }

  // Block cloud metadata endpoints
  const blocked = ['metadata.google.internal', 'metadata.google.com', 'instance-data'];
  if (blocked.some(h => hostname === h || hostname.endsWith('.' + h))) {
    throw new Error('Blocked: cloud metadata endpoint');
  }

  // Block link-local / metadata IPs
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const a = Number(ipMatch[1]);
    const b = Number(ipMatch[2]);
    if (a === 169 && b === 254) throw new Error('Blocked: link-local/cloud metadata (169.254.x.x)');
    if (a === 0) throw new Error('Blocked: invalid IP range (0.x.x.x)');
  }
}

/**
 * Build JSON Schema properties from endpoint parameter definitions.
 */
function buildParameterSchema(params: HttpEndpointConfig['parameters']): {
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
} {
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];

  for (const [name, rawDef] of Object.entries(params)) {
    const def = rawDef as EndpointParamDef;
    properties[name] = {
      type: def.type || 'string',
      ...(def.description ? { description: def.description } : {}),
    };
    if (def.required) {
      required.push(name);
    }
  }

  return { properties, required };
}

/**
 * Resolve auth headers/params for an HTTP plugin request.
 */
function resolveAuth(
  plugin: HttpPluginConfig,
  secretsStore: SecretsStore,
): { headers: Record<string, string>; queryParams: Record<string, string> } {
  const headers: Record<string, string> = {};
  const queryParams: Record<string, string> = {};

  if (!plugin.auth) return { headers, queryParams };

  const token = secretsStore.get(plugin.auth.tokenSecret, 'token') || '';
  if (!token) return { headers, queryParams };

  switch (plugin.auth.type) {
    case 'bearer':
      headers['Authorization'] = `Bearer ${token}`;
      break;
    case 'header':
      headers[plugin.auth.headerName || 'X-API-Key'] = token;
      break;
    case 'query':
      queryParams[plugin.auth.queryParam || 'api_key'] = token;
      break;
    case 'basic':
      headers['Authorization'] = `Basic ${Buffer.from(token).toString('base64')}`;
      break;
  }

  return { headers, queryParams };
}

/**
 * Register all enabled HTTP plugins as tools in the registry.
 * Returns the list of registered tool names.
 */
export function registerHttpPlugins(
  config: GatewayConfig,
  toolRegistry: ToolRegistry,
  secretsStore: SecretsStore,
  logger: Logger,
  mediaStore?: MediaStore,
): string[] {
  const plugins = config.plugins?.http || [];
  const registered: string[] = [];

  for (const plugin of plugins) {
    if (!plugin.enabled) continue;

    // Validate base URL at registration time
    try {
      validatePluginUrl(plugin.baseUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ plugin: plugin.name, baseUrl: plugin.baseUrl }, `HTTP plugin skipped: ${msg}`);
      continue;
    }

    for (const endpoint of plugin.endpoints) {
      const toolName = `http_${plugin.name}_${endpoint.name}`;
      const { properties, required } = buildParameterSchema(endpoint.parameters);

      const registration: ToolRegistration = {
        definition: {
          name: toolName,
          description: `${endpoint.description || `${endpoint.method} ${endpoint.path}`}\nPlugin: ${plugin.name} (${plugin.description || plugin.baseUrl})`,
          parameters: {
            type: 'object',
            properties,
            required: required.length > 0 ? required : undefined,
          },
        },
        executor: async (args) => {
          try {
            // Build URL
            const url = new URL(endpoint.path, plugin.baseUrl);

            // Apply defaults for missing optional params
            const resolvedArgs: Record<string, unknown> = {};
            for (const [name, rawDef] of Object.entries(endpoint.parameters)) {
              const def = rawDef as EndpointParamDef;
              if (args[name] !== undefined) {
                resolvedArgs[name] = args[name];
              } else if (def.default !== undefined) {
                resolvedArgs[name] = def.default;
              }
            }

            // Resolve auth
            const { headers: authHeaders, queryParams: authQueryParams } = resolveAuth(plugin, secretsStore);

            // Build request
            const requestHeaders: Record<string, string> = {
              'User-Agent': 'Kairo/2.0',
              ...authHeaders,
            };

            const isBodyMethod = ['POST', 'PUT', 'PATCH'].includes(endpoint.method);

            if (isBodyMethod) {
              // Body methods: params go in JSON body
              requestHeaders['Content-Type'] = 'application/json';
            } else {
              // GET/DELETE: params as query string
              for (const [k, v] of Object.entries(resolvedArgs)) {
                url.searchParams.set(k, String(v));
              }
            }

            // Add auth query params
            for (const [k, v] of Object.entries(authQueryParams)) {
              url.searchParams.set(k, v);
            }

            const fetchOpts: RequestInit = {
              method: endpoint.method,
              headers: requestHeaders,
              signal: AbortSignal.timeout(plugin.timeout * 1000),
            };

            if (isBodyMethod && Object.keys(resolvedArgs).length > 0) {
              fetchOpts.body = JSON.stringify(resolvedArgs);
            }

            const res = await fetch(url.toString(), fetchOpts);
            const contentType = res.headers.get('content-type') || '';

            // ── Binary image response (e.g. /generate returns PNG) ──
            const imgExt = extFromContentType(contentType);
            if (imgExt && mediaStore) {
              const buf = Buffer.from(await res.arrayBuffer());
              const filename = mediaStore.save(buf, imgExt);
              const mediaUrl = mediaStore.getUrl(filename);
              return {
                status: res.status,
                mediaUrl,
                mediaType: contentType,
                sizeBytes: buf.length,
                note: `Image saved. Use markdown to show: ![image](${mediaUrl})`,
              };
            }

            // ── JSON response — check for embedded base64 images ──
            let body: unknown;
            if (contentType.includes('application/json')) {
              body = await res.json();

              // Scan JSON fields for base64 images and replace with URLs
              if (mediaStore && body && typeof body === 'object' && !Array.isArray(body)) {
                const obj = body as Record<string, unknown>;
                for (const [key, val] of Object.entries(obj)) {
                  if (typeof val !== 'string') continue;
                  const detected = detectBase64Image(val);
                  if (detected) {
                    const filename = mediaStore.saveBase64(val, detected.ext);
                    const mediaUrl = mediaStore.getUrl(filename);
                    obj[key] = mediaUrl;
                    // Add metadata so LLM knows this is an image URL
                    obj[`${key}_type`] = detected.mime;
                    obj[`${key}_note`] = `Image saved. Use markdown: ![image](${mediaUrl})`;
                  }
                }
              }
            } else {
              body = await res.text();
            }

            // Truncate
            const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
            const truncated = bodyStr.length > MAX_RESPONSE_SIZE
              ? bodyStr.slice(0, MAX_RESPONSE_SIZE) + '\n... (truncated)'
              : bodyStr;

            if (!res.ok) {
              return {
                error: `HTTP ${res.status} ${res.statusText}`,
                body: truncated,
              };
            }

            return {
              status: res.status,
              body: typeof body === 'string' ? truncated : body,
            };
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            return { error: `HTTP plugin request failed: ${message}` };
          }
        },
        source: 'http_plugin',
        category: 'execute',
      };

      toolRegistry.register(registration);
      registered.push(toolName);
      logger.info({ plugin: plugin.name, endpoint: endpoint.name, tool: toolName }, 'HTTP plugin endpoint registered');
    }
  }

  return registered;
}
