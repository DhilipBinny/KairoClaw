/**
 * HTTP Plugin Module — registers HTTP API tools into the ToolRegistry.
 *
 * Each enabled HTTP plugin creates one tool per endpoint:
 * `http_{pluginName}_{endpointName}`.
 */

import path from 'node:path';
import type { GatewayConfig, HttpPluginConfig, HttpEndpointConfig, MediaAttachment } from '@agw/types';

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
 * Resolve a JSON path like "data[0].b64_json" against an object.
 * Supports dot notation and array indexing.
 */
function resolveJsonPath(obj: unknown, jsonPath: string): unknown {
  const parts = jsonPath.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a value at a JSON path like "data[0].b64_json".
 */
function setJsonPath(obj: unknown, jsonPath: string, value: unknown): void {
  const parts = jsonPath.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current == null || typeof current !== 'object') return;
    current = (current as Record<string, unknown>)[parts[i]];
  }
  if (current != null && typeof current === 'object') {
    (current as Record<string, unknown>)[parts[parts.length - 1]] = value;
  }
}

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
              const filePath = path.join(mediaStore.dir, filename);
              const _media: MediaAttachment[] = [{
                type: 'image',
                filePath,
                fileName: filename,
                mimeType: contentType.split(';')[0].trim(),
                url: mediaUrl,
              }];
              return {
                status: res.status,
                mediaUrl,
                mediaType: contentType,
                sizeBytes: buf.length,
                note: `Image saved. Use markdown to show: ![image](${mediaUrl})`,
                _media,
              };
            }

            // ── JSON response — extract media using explicit mapping or auto-detect ──
            let body: unknown;
            const b64Media: MediaAttachment[] = [];
            if (contentType.includes('application/json')) {
              body = await res.json();

              if (mediaStore && body && typeof body === 'object') {
                // Strategy 1: Use explicit responseMedia mappings (from OpenAPI spec or manual config)
                if (endpoint.responseMedia && endpoint.responseMedia.length > 0) {
                  for (const mapping of endpoint.responseMedia) {
                    const value = resolveJsonPath(body, mapping.path);
                    if (typeof value !== 'string' || !value) continue;

                    if (mapping.encoding === 'base64') {
                      const ext = mapping.mimeType.split('/')[1] || 'png';
                      const filename = mediaStore.saveBase64(value, ext);
                      const mediaUrl = mediaStore.getUrl(filename);
                      const filePath = path.join(mediaStore.dir, filename);
                      // Replace the base64 in the response with the URL
                      setJsonPath(body, mapping.path, mediaUrl);
                      b64Media.push({
                        type: 'image',
                        filePath,
                        fileName: filename,
                        mimeType: mapping.mimeType,
                        url: mediaUrl,
                      });
                    } else if (mapping.encoding === 'url') {
                      // URL-based: download and save
                      try {
                        const imgRes = await fetch(value, { signal: AbortSignal.timeout(30000) });
                        const buf = Buffer.from(await imgRes.arrayBuffer());
                        const ext = mapping.mimeType.split('/')[1] || 'png';
                        const filename = mediaStore.save(buf, ext);
                        const mediaUrl = mediaStore.getUrl(filename);
                        const filePath = path.join(mediaStore.dir, filename);
                        b64Media.push({
                          type: 'image',
                          filePath,
                          fileName: filename,
                          mimeType: mapping.mimeType,
                          url: mediaUrl,
                        });
                      } catch { /* URL download failed, skip */ }
                    }
                  }
                } else {
                  // Strategy 2: Fallback — auto-detect base64 images by scanning all string fields
                  const scanObj = (obj: Record<string, unknown>) => {
                    for (const [key, val] of Object.entries(obj)) {
                      if (typeof val === 'string') {
                        const detected = detectBase64Image(val);
                        if (detected) {
                          const filename = mediaStore!.saveBase64(val, detected.ext);
                          const mediaUrl = mediaStore!.getUrl(filename);
                          const filePath = path.join(mediaStore!.dir, filename);
                          obj[key] = mediaUrl;
                          obj[`${key}_type`] = detected.mime;
                          obj[`${key}_note`] = `Image saved. Use markdown: ![image](${mediaUrl})`;
                          b64Media.push({
                            type: 'image',
                            filePath,
                            fileName: filename,
                            mimeType: detected.mime,
                            url: mediaUrl,
                          });
                        }
                      } else if (Array.isArray(val)) {
                        for (const item of val) {
                          if (item && typeof item === 'object' && !Array.isArray(item)) {
                            scanObj(item as Record<string, unknown>);
                          }
                        }
                      } else if (val && typeof val === 'object') {
                        scanObj(val as Record<string, unknown>);
                      }
                    }
                  };
                  scanObj(body as Record<string, unknown>);
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
              ...(b64Media.length > 0 ? { _media: b64Media } : {}),
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
