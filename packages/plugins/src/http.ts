/**
 * HTTP Plugin Module — registers HTTP API tools into the ToolRegistry.
 *
 * Each enabled HTTP plugin creates one tool per endpoint:
 * `http_{pluginName}_{endpointName}`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fetch, type Response as UndiciResponse } from 'undici';
import type { GatewayConfig, HttpPluginConfig, HttpEndpointConfig, MediaAttachment } from '@agw/types';

type EndpointParamDef = { type: string; description?: string; required?: boolean; default?: unknown };
import type { ToolRegistration } from '@agw/tool-platform';
import type { PluginToolRegistry as ToolRegistry } from './interfaces.js';
import type { PluginSecretsResolver as SecretsStore } from './interfaces.js';
import type { PluginMediaStore as MediaStore } from './interfaces.js';
import { detectBase64Image, extFromContentType, sniffBase64Mime } from './media-utils.js';
import { ssrfSafeDispatcher, blockedIpReason } from './ssrf.js';
import type { AgwLogger } from '@agw/types';
type Logger = AgwLogger;

/** Max response size returned to the LLM. */
const MAX_RESPONSE_SIZE = 10 * 1024;

/**
 * Hard ceiling on how many bytes we read from a plugin response body, including
 * binary/image downloads. Without this a malicious or buggy endpoint returning
 * a multi-GB body would be buffered entirely into memory and OOM the process.
 */
const MAX_DOWNLOAD_SIZE = 25 * 1024 * 1024;

/**
 * Read a response body into a Buffer, aborting if it exceeds `maxBytes`.
 * Honours Content-Length when present and also enforces the cap while streaming
 * (a lying or absent Content-Length cannot bypass it).
 */
/**
 * Release a response we are about to discard (a redirect hop, a 5xx we'll retry,
 * an error response) so its socket is returned to the shared dispatcher pool
 * instead of lingering until keep-alive timeout.
 */
function discardBody(res: UndiciResponse | undefined): void {
  if (typeof res?.body?.cancel === 'function') res.body.cancel().catch(() => { /* best effort */ });
}

export async function readBodyCapped(res: UndiciResponse, maxBytes = MAX_DOWNLOAD_SIZE): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Cancel the body, else the undici socket is never drained and is lost from
    // the shared dispatcher's connection pool.
    if (typeof res.body?.cancel === 'function') res.body.cancel().catch(() => { /* best effort */ });
    throw new Error(`Response too large: ${declared} bytes (max ${maxBytes})`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`Response too large: exceeded ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

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
 * Validate a URL for HTTP plugins (a fast pre-flight string check).
 * Admin explicitly configured these URLs, so private IPs are allowed.
 * Block bad schemes, loopback/metadata hostnames, and loopback/link-local/
 * metadata literal IPs (IPv4, IPv6 and IPv4-mapped). The authoritative defence
 * against DNS rebinding is the connection-pinning dispatcher (see ssrf.ts) —
 * this check just rejects obviously-bad URLs early.
 */
export function validatePluginUrl(urlStr: string): void {
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

  // Block loopback hostnames (literal loopback IPs are caught by blockedIpReason).
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Blocked: localhost/loopback URLs not allowed');
  }

  // Block cloud metadata endpoints
  const blocked = ['metadata.google.internal', 'metadata.google.com', 'instance-data'];
  if (blocked.some(h => hostname === h || hostname.endsWith('.' + h))) {
    throw new Error('Blocked: cloud metadata endpoint');
  }

  // Block loopback / link-local / metadata literal IPs (v4, v6, IPv4-mapped).
  // URL.hostname keeps the brackets around IPv6 literals — strip them first.
  const ipReason = blockedIpReason(hostname.replace(/^\[|\]$/g, ''));
  if (ipReason) throw new Error(`Blocked: ${ipReason}`);
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

      const searchTerms = [plugin.name, endpoint.name, endpoint.description || ''].join(' ');

      const registration: ToolRegistration = {
        definition: {
          name: toolName,
          description: `${endpoint.description || `${endpoint.method} ${endpoint.path}`}\nPlugin: ${plugin.name} (${plugin.description || plugin.baseUrl})`,
          searchHint: searchTerms,
          parameters: {
            type: 'object',
            properties,
            required: required.length > 0 ? required : undefined,
          },
        },
        executor: async (args) => {
          try {
            // Build URL — string concat preserves baseUrl path prefix
            const base = plugin.baseUrl.replace(/\/$/, '');
            const ep = endpoint.path.startsWith('/') ? endpoint.path : `/${endpoint.path}`;
            const url = new URL(`${base}${ep}`);

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

            // Auto-convert media references to base64 for parameters expecting image data.
            // Only resolves /api/v1/media/ URLs — never arbitrary file paths (path traversal risk).
            if (mediaStore) {
              for (const [name, rawDef] of Object.entries(endpoint.parameters)) {
                const def = rawDef as EndpointParamDef;
                const val = resolvedArgs[name];
                if (typeof val !== 'string' || !val) continue;
                const desc = (def.description || '').toLowerCase();
                if (!desc.includes('base64')) continue;
                if (val.length > 1000) continue;
                if (!val.startsWith('/api/v1/media/')) continue;
                const baseDir = fs.realpathSync(mediaStore.dir);
                const candidate = path.join(baseDir, path.basename(val.split('?')[0]));
                let resolved: string;
                try { resolved = fs.realpathSync(candidate); } catch { continue; }
                if (!resolved.startsWith(baseDir + path.sep)) continue;
                resolvedArgs[name] = fs.readFileSync(resolved).toString('base64');
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

            const fetchOpts: Parameters<typeof fetch>[1] = {
              method: endpoint.method,
              headers: requestHeaders,
              signal: AbortSignal.timeout(plugin.timeout * 1000),
              redirect: 'manual',
              dispatcher: ssrfSafeDispatcher(),
            };

            if (isBodyMethod && Object.keys(resolvedArgs).length > 0) {
              fetchOpts.body = JSON.stringify(resolvedArgs);
            }

            let res!: UndiciResponse;
            for (let attempt = 0; attempt <= 2; attempt++) {
              try {
                res = await fetch(url.toString(), fetchOpts);

                // Follow redirects manually with SSRF validation on each hop
                let redirects = 0;
                while (res.status >= 300 && res.status < 400 && redirects < 5) {
                  const location = res.headers.get('location');
                  if (!location) break;
                  const redirectUrl = new URL(location, url.toString()).toString();
                  validatePluginUrl(redirectUrl);
                  discardBody(res); // release the redirect response before the next hop
                  res = await fetch(redirectUrl, { ...fetchOpts, method: 'GET', body: undefined });
                  redirects++;
                }

                if (res.status < 500 || attempt === 2) break;
                discardBody(res); // release the 5xx response before retrying
                await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
              } catch (fetchErr) {
                if (attempt === 2) throw fetchErr;
                await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
              }
            }
            const contentType = res.headers.get('content-type') || '';

            // ── Binary image response (e.g. /generate returns PNG) ──
            const imgExt = extFromContentType(contentType);
            if (imgExt && !mediaStore) {
              return { error: `Response is a binary image (${contentType}) but no media store is configured — cannot save.` };
            }
            if (imgExt && mediaStore) {
              const buf = await readBodyCapped(res);
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
              body = JSON.parse((await readBodyCapped(res)).toString('utf8'));

              if (mediaStore && body && typeof body === 'object') {
                // Strategy 1: Use explicit responseMedia mappings (from OpenAPI spec or manual config)
                if (endpoint.responseMedia && endpoint.responseMedia.length > 0) {
                  for (const mapping of endpoint.responseMedia) {
                    const value = resolveJsonPath(body, mapping.path);
                    if (typeof value !== 'string' || !value) continue;

                    if (mapping.encoding === 'base64') {
                      const sniffed = sniffBase64Mime(value);
                      const actualMime = sniffed?.mime || mapping.mimeType;
                      const ext = sniffed?.ext || mapping.mimeType.split('/')[1] || 'png';
                      const filename = mediaStore.saveBase64(value, ext);
                      const mediaUrl = mediaStore.getUrl(filename);
                      const filePath = path.join(mediaStore.dir, filename);
                      setJsonPath(body, mapping.path, mediaUrl);
                      b64Media.push({
                        type: 'image',
                        filePath,
                        fileName: filename,
                        mimeType: actualMime,
                        url: mediaUrl,
                      });
                    } else if (mapping.encoding === 'url') {
                      // URL-based: download and save (restrict to same host as plugin)
                      try {
                        validatePluginUrl(value);
                        const responseHost = new URL(value).hostname;
                        const pluginHost = new URL(plugin.baseUrl).hostname;
                        if (responseHost !== pluginHost) {
                          continue; // skip URLs pointing to a different host
                        }
                        const imgRes = await fetch(value, { signal: AbortSignal.timeout(30000), dispatcher: ssrfSafeDispatcher() });
                        const buf = await readBodyCapped(imgRes);
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
              body = (await readBodyCapped(res)).toString('utf8');
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
              body: bodyStr.length > MAX_RESPONSE_SIZE ? truncated : body,
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
