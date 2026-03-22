/**
 * OpenAPI Auto-Import — fetch /openapi.json from a service and convert
 * its paths into HttpPluginConfig entries for the HTTP plugin system.
 *
 * Usage:
 *   const plugin = await importOpenAPIService({
 *     name: 'flux2',
 *     baseUrl: 'http://10.0.2.20:5006',
 *   });
 *   // → HttpPluginConfig with endpoints auto-discovered from the spec
 *
 * Supports OpenAPI 3.0 and 3.1 specs. Skips health/models endpoints
 * by default (configurable via `skipPaths`).
 */

import type { HttpPluginConfig, HttpEndpointConfig, ResponseMediaMapping } from '@agw/types';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('plugins');

export interface OpenAPIImportOptions {
  /** Unique plugin name (lowercase alphanumeric + underscores). */
  name: string;
  /** Base URL of the service (e.g. http://10.0.2.20:5006). */
  baseUrl: string;
  /** Override description (otherwise uses spec info.description). */
  description?: string;
  /** Request timeout in seconds. */
  timeout?: number;
  /** Paths to skip (default: ['/health', '/v1/models', '/openapi.json']). */
  skipPaths?: string[];
  /** Whether the plugin is enabled. */
  enabled?: boolean;
}

interface OpenAPISpec {
  openapi?: string;
  info?: { title?: string; description?: string; version?: string };
  paths?: Record<string, Record<string, OpenAPIOperation>>;
}

interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  requestBody?: {
    content?: Record<string, { schema?: OpenAPISchema }>;
  };
  responses?: Record<string, {
    content?: Record<string, { schema?: OpenAPISchema }>;
  }>;
  parameters?: Array<{
    name: string;
    in: string;
    description?: string;
    required?: boolean;
    schema?: { type?: string; default?: unknown };
  }>;
}

interface OpenAPISchema {
  type?: string;
  required?: string[];
  properties?: Record<string, OpenAPISchemaProperty>;
  items?: OpenAPISchemaProperty;
}

interface OpenAPISchemaProperty {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  format?: string;
  properties?: Record<string, OpenAPISchemaProperty>;
  items?: OpenAPISchemaProperty;
}

const DEFAULT_SKIP_PATHS = ['/health', '/v1/models', '/openapi.json'];

/** Known field names/patterns that indicate base64 image data. */
const BASE64_IMAGE_FIELD_NAMES = ['b64_json', 'b64', 'image', 'image_data', 'image_base64'];
const IMAGE_DESCRIPTION_PATTERNS = [/base64.*image/i, /image.*base64/i, /encoded.*png/i, /encoded.*image/i];

/**
 * Walk an OpenAPI response schema and detect fields that contain media.
 * Builds JSON path expressions (e.g. "data[0].b64_json") for each media field found.
 */
function detectResponseMedia(operation: OpenAPIOperation): ResponseMediaMapping[] {
  const mappings: ResponseMediaMapping[] = [];

  const resp200 = operation.responses?.['200'];
  if (!resp200?.content) return mappings;

  const jsonSchema = resp200.content['application/json']?.schema;
  if (!jsonSchema) return mappings;

  // Recursively scan properties for media fields
  function scanSchema(schema: OpenAPISchemaProperty, pathPrefix: string): void {
    if (!schema.properties) return;

    for (const [name, prop] of Object.entries(schema.properties)) {
      const currentPath = pathPrefix ? `${pathPrefix}.${name}` : name;

      // Check if this field is a media field
      if (prop.type === 'string') {
        const isMediaByName = BASE64_IMAGE_FIELD_NAMES.includes(name.toLowerCase());
        const isMediaByDesc = prop.description
          ? IMAGE_DESCRIPTION_PATTERNS.some(p => p.test(prop.description!))
          : false;

        if (isMediaByName || isMediaByDesc) {
          mappings.push({
            path: currentPath,
            encoding: 'base64',
            mimeType: 'image/png',
          });
          continue;
        }

        // URL-based media: field named "url" with description mentioning image
        if ((name === 'url' || name === 'image_url') && prop.description && /image/i.test(prop.description)) {
          mappings.push({
            path: currentPath,
            encoding: 'url',
            mimeType: 'image/png',
          });
          continue;
        }
      }

      // Recurse into nested objects
      if (prop.properties) {
        scanSchema(prop, currentPath);
      }

      // Recurse into array items
      if (prop.type === 'array' && prop.items?.properties) {
        scanSchema(prop.items, `${currentPath}[0]`);
      }
    }
  }

  scanSchema(jsonSchema as OpenAPISchemaProperty, '');
  return mappings;
}

/**
 * Fetch an OpenAPI spec from a service and convert it to an HttpPluginConfig.
 */
export async function importOpenAPIService(
  opts: OpenAPIImportOptions,
): Promise<HttpPluginConfig> {
  const {
    name,
    baseUrl,
    description,
    timeout = 120,
    skipPaths = DEFAULT_SKIP_PATHS,
    enabled = true,
  } = opts;

  const specUrl = `${baseUrl.replace(/\/$/, '')}/openapi.json`;

  log.info({ name, specUrl }, 'Fetching OpenAPI spec');

  const res = await fetch(specUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch OpenAPI spec from ${specUrl}: ${res.status} ${res.statusText}`);
  }

  const spec = await res.json() as OpenAPISpec;

  if (!spec.paths || Object.keys(spec.paths).length === 0) {
    throw new Error(`OpenAPI spec from ${specUrl} has no paths`);
  }

  const endpoints: HttpEndpointConfig[] = [];

  for (const [pathStr, methods] of Object.entries(spec.paths)) {
    // Skip health, models, and other non-functional endpoints
    if (skipPaths.some(skip => pathStr === skip)) continue;

    for (const [method, operation] of Object.entries(methods)) {
      const httpMethod = method.toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(httpMethod)) continue;

      const endpointName = operation.operationId
        || `${httpMethod.toLowerCase()}_${pathStr.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;

      const parameters: Record<string, { type: string; description?: string; required?: boolean; default?: unknown }> = {};

      // Extract from request body schema (for POST/PUT/PATCH)
      if (operation.requestBody?.content) {
        const jsonContent = operation.requestBody.content['application/json'];
        if (jsonContent?.schema?.properties) {
          const requiredFields = new Set(jsonContent.schema.required || []);
          for (const [propName, propDef] of Object.entries(jsonContent.schema.properties)) {
            // Skip binary fields (file uploads) — those need multipart, not JSON
            if (propDef.type === 'string' && propDef.format === 'binary') continue;

            parameters[propName] = {
              type: propDef.type || 'string',
              ...(propDef.description ? { description: propDef.description } : {}),
              ...(requiredFields.has(propName) ? { required: true } : {}),
              ...(propDef.default !== undefined ? { default: propDef.default } : {}),
            };
          }
        }

        // For multipart/form-data, extract non-binary fields
        const formContent = operation.requestBody.content['multipart/form-data'];
        if (formContent?.schema?.properties && !jsonContent) {
          const requiredFields = new Set(formContent.schema.required || []);
          for (const [propName, propDef] of Object.entries(formContent.schema.properties)) {
            if (propDef.type === 'string' && propDef.format === 'binary') continue;
            parameters[propName] = {
              type: propDef.type || 'string',
              ...(propDef.description ? { description: propDef.description } : {}),
              ...(requiredFields.has(propName) ? { required: true } : {}),
              ...(propDef.default !== undefined ? { default: propDef.default } : {}),
            };
          }
        }
      }

      // Extract from URL/query parameters (for GET/DELETE)
      if (operation.parameters) {
        for (const param of operation.parameters) {
          if (param.in === 'query' || param.in === 'path') {
            parameters[param.name] = {
              type: param.schema?.type || 'string',
              ...(param.description ? { description: param.description } : {}),
              ...(param.required ? { required: true } : {}),
              ...(param.schema?.default !== undefined ? { default: param.schema.default } : {}),
            };
          }
        }
      }

      // Detect media fields in response schema
      const responseMedia = detectResponseMedia(operation);

      endpoints.push({
        name: endpointName,
        method: httpMethod as HttpEndpointConfig['method'],
        path: pathStr,
        description: operation.summary || operation.description || `${httpMethod} ${pathStr}`,
        parameters,
        ...(responseMedia.length > 0 ? { responseMedia } : {}),
      });
    }
  }

  if (endpoints.length === 0) {
    throw new Error(`OpenAPI spec from ${specUrl} has no usable endpoints after filtering`);
  }

  const pluginDescription = description
    || spec.info?.description
    || `${spec.info?.title || name} (auto-imported from OpenAPI)`;

  log.info({ name, endpoints: endpoints.length }, 'OpenAPI service imported');

  return {
    name,
    baseUrl: baseUrl.replace(/\/$/, ''),
    description: pluginDescription,
    enabled,
    timeout,
    endpoints,
  };
}

/**
 * Import multiple OpenAPI services and merge them into existing HTTP plugins.
 * Skips services that fail to respond or parse. Returns the updated list.
 */
export async function importAllOpenAPIServices(
  services: OpenAPIImportOptions[],
  existingPlugins: HttpPluginConfig[],
): Promise<{ plugins: HttpPluginConfig[]; imported: string[]; errors: Array<{ name: string; error: string }> }> {
  const existingNames = new Set(existingPlugins.map(p => p.name));
  const imported: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  const newPlugins = [...existingPlugins];

  for (const service of services) {
    try {
      const plugin = await importOpenAPIService(service);

      // Replace existing or add new
      const idx = newPlugins.findIndex(p => p.name === plugin.name);
      if (idx >= 0) {
        newPlugins[idx] = plugin;
      } else {
        newPlugins.push(plugin);
      }
      imported.push(plugin.name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn({ service: service.name, err: msg }, 'Failed to import OpenAPI service');
      errors.push({ name: service.name, error: msg });
    }
  }

  return { plugins: newPlugins, imported, errors };
}
