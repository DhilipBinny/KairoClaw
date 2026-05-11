/**
 * Plugin Zod schemas — canonical validation for plugin configuration.
 *
 * Extracted from packages/core/src/config/schema.ts so that both
 * @agw/core and @agw/plugins can share the same validation logic.
 */

import { z } from 'zod/v4';

// ── CLI Plugin ───────────────────────────────────────────

export const cliPluginSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, 'Must be lowercase alphanumeric + underscores'),
  command: z.string().min(1).regex(/^[a-zA-Z0-9_\-.]+$/, 'Must be a simple binary name (alphanumeric, hyphens, underscores, dots)'),
  description: z.string().default(''),
  enabled: z.boolean().default(true),
  timeout: z.number().int().min(1).max(120).default(30),
  allowedSubcommands: z.array(z.string()).default([]),
  blockedSubcommands: z.array(z.string()).default([]),
  requireConfirmation: z.array(z.string()).default([]),
  env: z.array(z.string()).default([]),
});

// ── HTTP Plugin ──────────────────────────────────────────

const httpEndpointParameterSchema = z.object({
  type: z.string().default('string'),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
});

const responseMediaMappingSchema = z.object({
  path: z.string().min(1),
  encoding: z.enum(['base64', 'url']),
  mimeType: z.string().default('image/png'),
});

export const httpEndpointSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, 'Must be lowercase alphanumeric + underscores'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  path: z.string().min(1),
  description: z.string().default(''),
  parameters: z.record(z.string(), httpEndpointParameterSchema).default({}),
  responseMedia: z.array(responseMediaMappingSchema).optional(),
});

const httpPluginAuthSchema = z.object({
  type: z.enum(['bearer', 'header', 'query', 'basic']),
  tokenSecret: z.string().min(1),
  headerName: z.string().optional(),
  queryParam: z.string().optional(),
});

export const httpPluginSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, 'Must be lowercase alphanumeric + underscores'),
  baseUrl: z.string().url(),
  description: z.string().default(''),
  enabled: z.boolean().default(true),
  timeout: z.number().int().min(1).max(600).default(30),
  auth: httpPluginAuthSchema.optional(),
  endpoints: z.array(httpEndpointSchema).default([]),
});

// ── OpenAPI Service ──────────────────────────────────────

export const openAPIServiceSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, 'Must be lowercase alphanumeric + underscores'),
  baseUrl: z.string().url(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  timeout: z.number().int().min(1).max(600).default(120),
  skipPaths: z.array(z.string()).optional(),
});

// ── Combined Plugins Config ──────────────────────────────

export const pluginsSchema = z.object({
  cli: z.array(cliPluginSchema).default([]),
  http: z.array(httpPluginSchema).default([]),
  openapi: z.array(openAPIServiceSchema).default([]),
  _seededDefaults: z.array(z.string()).optional(),
});
