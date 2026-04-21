import { z } from 'zod';
import type { GatewayConfig } from '@agw/types';

// ──────────────────────────────────────────────
// Zod schemas for config validation
//
// We use z.preprocess to handle missing sub-objects: if the value is
// undefined, substitute an empty object so the inner z.object defaults
// are applied. This avoids the typing issues with z.default({}) on
// objects whose fields all have their own defaults.
// ──────────────────────────────────────────────

function withObjectDefault<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((val) => (val === undefined ? {} : val), schema);
}

const anthropicProviderSchema = z.object({
  apiKey: z.string().default(''),
  baseUrl: z.string().default(''),
  defaultModel: z.string().default('claude-sonnet-4-6'),
  apiKeyFile: z.string().optional(),
});

const openaiProviderSchema = z.object({
  apiKey: z.string().default(''),
  defaultModel: z.string().default('gpt-4o'),
  apiKeyFile: z.string().optional(),
});

const ollamaProviderSchema = z.object({
  baseUrl: z.string().default(''),
  defaultModel: z.string().default('llama3.3'),
});

const kairoPremiumSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['oauth', 'sdk']).default('oauth'),
  defaultModel: z.string().default('claude-sonnet-4-6'),
});

const providersSchema = z.object({
  anthropic: withObjectDefault(anthropicProviderSchema),
  openai: withObjectDefault(openaiProviderSchema),
  ollama: withObjectDefault(ollamaProviderSchema),
  kairoPremium: withObjectDefault(kairoPremiumSchema),
});

const gatewayNetworkSchema = z.object({
  port: z.number().int().min(1).max(65535).default(18181),
  host: z.string().default('0.0.0.0'),
  token: z.string().default(''),
  tokenFile: z.string().optional(),
});

const modelSelectionSchema = z.object({
  primary: z.string().default('anthropic/claude-sonnet-4-6'),
  fallback: z.string().default(''),
  fallbackChain: z.array(z.string()).optional(),
});

const sessionSchema = z.object({
  resetHour: z.number().int().min(0).max(23).default(4),
  idleMinutes: z.number().int().min(0).default(0),
});

const execToolSchema = z.object({
  enabled: z.boolean().default(true),
  timeout: z.number().int().min(1).default(30),
});

const webSearchToolSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().default(''),
  apiKeyFile: z.string().optional(),
});

const webFetchToolSchema = z.object({
  enabled: z.boolean().default(true),
  maxChars: z.number().int().min(0).default(50000),
});

const emailToolSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default(''),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  from: z.string().default(''),
  allowedDomains: z.array(z.string()).default([]),
  allowedRecipients: z.array(z.string()).default([]),
  maxRecipientsPerMessage: z.number().int().min(1).default(5),
  rateLimit: withObjectDefault(z.object({
    perMinute: z.number().int().min(1).default(5),
    perHour: z.number().int().min(1).default(20),
    perDay: z.number().int().min(1).default(50),
    perRecipientPerHour: z.number().int().min(1).default(3),
  })),
});

const transcriptionToolSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default(''),
  model: z.string().default('whisper-small'),
  language: z.string().default(''),
});

const browseToolSchema = z.object({
  enabled: z.boolean().default(true),
  /** Allow Chrome extension remote browsing. 'admin' = admin only (beta), 'all' = all users, false = disabled */
  remoteAccess: z.enum(['admin', 'all']).or(z.literal(false)).default('admin'),
});

const toolsSchema = z.object({
  exec: withObjectDefault(execToolSchema),
  webSearch: withObjectDefault(webSearchToolSchema),
  webFetch: withObjectDefault(webFetchToolSchema),
  email: withObjectDefault(emailToolSchema),
  transcription: withObjectDefault(transcriptionToolSchema),
  browse: withObjectDefault(browseToolSchema),
});

const telegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(''),
  allowFrom: z.array(z.union([z.number(), z.string()])).default([]),
  groupsEnabled: z.boolean().default(true),
  groupRequireMention: z.boolean().default(true),
  groupAllowFrom: z.array(z.string()).default([]),
  groupRequireAllowFrom: z.boolean().default(true),
  tokenFile: z.string().optional(),
  outboundPolicy: z.enum(['session-only', 'unrestricted']).default('session-only'),
  outboundAllowlist: z.array(z.string()).default([]),
});

const whatsappChannelSchema = z.object({
  enabled: z.boolean().default(false),
  allowFrom: z.array(z.string()).default([]),
  groupsEnabled: z.boolean().default(true),
  groupRequireMention: z.boolean().default(true),
  groupAllowFrom: z.array(z.string()).default([]),
  groupRequireAllowFrom: z.boolean().default(true),
  sendReadReceipts: z.boolean().default(true),
  outboundPolicy: z.enum(['session-only', 'unrestricted']).default('session-only'),
  outboundAllowlist: z.array(z.string()).default([]),
});

const channelsSchema = z.object({
  telegram: withObjectDefault(telegramChannelSchema),
  whatsapp: withObjectDefault(whatsappChannelSchema),
});

const thinkingShowSchema = z.object({
  web: z.boolean().default(true),
  telegram: z.boolean().default(false),
  whatsapp: z.boolean().default(false),
});

const thinkingSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['enabled', 'adaptive']).default('adaptive'),
  budgetTokens: z.number().int().min(1024).default(10000),
  showThinking: withObjectDefault(thinkingShowSchema),
});

const sessionMemorySchema = z.object({
  enabled: z.boolean().default(true),
  extractionModel: z.string().optional(),
  initTokenThreshold: z.number().int().min(0).optional(),
  growthTokenThreshold: z.number().int().min(0).optional(),
});

const contextInjectionSchema = z.object({
  profileMaxChars: z.number().int().min(0).optional(),
  sessionMemoryMaxChars: z.number().int().min(0).optional(),
  dailySessionDays: z.number().int().min(0).optional(),
  dailySessionMaxChars: z.number().int().min(0).optional(),
});

const routingSchema = z.object({
  enabled: z.boolean().default(false),
  forceModel: z.string().default(''),
  fastModel: z.string().default('anthropic/claude-haiku-4-5-20251001'),
  powerfulModel: z.string().default('anthropic/claude-opus-4-6'),
  llmClassifier: z.boolean().default(true),
  shortMessageThreshold: z.number().int().min(0).default(50),
  opusPatterns: z.array(z.string()).default([]),
  haikuPatterns: z.array(z.string()).default([]),
});

const modelIndicatorVisibility = z.enum(['off', 'admin_only', 'all']).default('off');

const modelIndicatorSchema = z.object({
  telegram: modelIndicatorVisibility,
  whatsapp: modelIndicatorVisibility,
  web: modelIndicatorVisibility,
});

const agentSchema = z.object({
  name: z.string().default('Assistant'),
  workspace: z.string().default('workspace'),
  maxToolRounds: z.number().int().min(1).default(25),
  compactionThreshold: z.number().min(0).max(1).default(0.75),
  softCompactionThreshold: z.number().min(0).max(1).default(0.50),
  keepRecentMessages: z.number().int().min(0).default(10),
  thinking: withObjectDefault(thinkingSchema),
  sessionMemory: withObjectDefault(sessionMemorySchema),
  contextInjection: withObjectDefault(contextInjectionSchema),
  routing: withObjectDefault(routingSchema),
  showModelIndicator: withObjectDefault(modelIndicatorSchema),
});

const modelCapabilityEntrySchema = z.object({
  contextWindow: z.number().default(128000),
  maxOutputTokens: z.number().default(8192),
  timeoutMs: z.number().default(120000),
  costPer1M: z.object({ input: z.number(), output: z.number() }).nullable().default(null),
  provider: z.string().default('unknown'),
  supportsVision: z.boolean().default(true),
  supportsToolCalling: z.boolean().default(true),
  supportsStreaming: z.boolean().default(true),
  supportsThinking: z.boolean().default(false),
  displayName: z.string().optional(),
  source: z.enum(['auto', 'manual']).default('auto'),
}).partial();

const modelsCatalogSchema = z.object({
  capabilities: z.record(z.string(), modelCapabilityEntrySchema).default({}),
});

const mcpServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  transport: z.enum(['stdio', 'sse']).default('stdio'),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  pinnedHash: z.string().optional(),
});

const mcpSectionSchema = z.object({
  servers: z.record(z.string(), mcpServerConfigSchema).default({}),
});

// ── Plugin schemas ──────────────────────────────────────────

const cliPluginSchema = z.object({
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

const httpEndpointSchema = z.object({
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

const httpPluginSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, 'Must be lowercase alphanumeric + underscores'),
  baseUrl: z.string().url(),
  description: z.string().default(''),
  enabled: z.boolean().default(true),
  timeout: z.number().int().min(1).max(600).default(30),
  auth: httpPluginAuthSchema.optional(),
  endpoints: z.array(httpEndpointSchema).default([]),
});

const openAPIServiceSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, 'Must be lowercase alphanumeric + underscores'),
  baseUrl: z.string().url(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  timeout: z.number().int().min(1).max(600).default(120),
  skipPaths: z.array(z.string()).optional(),
});

export const pluginsSchema = z.object({
  cli: z.array(cliPluginSchema).default([]),
  http: z.array(httpPluginSchema).default([]),
  /** OpenAPI services to auto-discover and import as HTTP plugins on startup. */
  openapi: z.array(openAPIServiceSchema).default([]),
  /** Tracks which default plugins have been offered (prevents re-adding removed ones). */
  _seededDefaults: z.array(z.string()).optional(),
});

export const configSchema = z.object({
  gateway: withObjectDefault(gatewayNetworkSchema),
  providers: withObjectDefault(providersSchema),
  model: withObjectDefault(modelSelectionSchema),
  channels: withObjectDefault(channelsSchema),
  session: withObjectDefault(sessionSchema),
  tools: withObjectDefault(toolsSchema),
  agent: withObjectDefault(agentSchema),
  models: withObjectDefault(modelsCatalogSchema),
  mcp: withObjectDefault(mcpSectionSchema),
}).passthrough();

// ──────────────────────────────────────────────
// Defaults
// ──────────────────────────────────────────────

export const configDefaults: GatewayConfig = {
  gateway: {
    port: 18181,
    host: '0.0.0.0',
    token: '${AGW_TOKEN}',
  },
  providers: {
    anthropic: {
      apiKey: '${ANTHROPIC_API_KEY}',
      baseUrl: '',
      defaultModel: 'claude-sonnet-4-6',
    },
    kairoPremium: {
      enabled: false,
      mode: 'oauth',
      defaultModel: 'claude-sonnet-4-6',
    },
    openai: {
      apiKey: '${OPENAI_API_KEY}',
      defaultModel: 'gpt-4o',
    },
    ollama: {
      baseUrl: '${OLLAMA_BASE_URL}',
      defaultModel: 'llama3.3',
    },
  },
  model: {
    primary: 'anthropic/claude-sonnet-4-6',
    fallback: '',
  },
  channels: {
    telegram: {
      enabled: false,
      botToken: '${TELEGRAM_BOT_TOKEN}',
      allowFrom: [],
      groupsEnabled: true,
      groupRequireMention: true,
      groupAllowFrom: [],
      groupRequireAllowFrom: true,
      outboundPolicy: 'session-only',
      outboundAllowlist: [],
    },
    whatsapp: {
      enabled: false,
      allowFrom: [],
      groupsEnabled: true,
      groupRequireMention: true,
      groupAllowFrom: [],
      groupRequireAllowFrom: true,
      sendReadReceipts: true,
      outboundPolicy: 'session-only',
      outboundAllowlist: [],
    },
  },
  session: {
    resetHour: 4,
    idleMinutes: 0,
  },
  tools: {
    exec: { enabled: true, timeout: 30 },
    webSearch: { enabled: false, apiKey: '${BRAVE_API_KEY}' },
    webFetch: { enabled: true, maxChars: 50000 },
    email: {
      enabled: false,
      host: '',
      port: 587,
      secure: false,
      from: '',
      allowedDomains: [],
      allowedRecipients: [],
      maxRecipientsPerMessage: 5,
      rateLimit: { perMinute: 5, perHour: 20, perDay: 50, perRecipientPerHour: 3 },
    },
    transcription: {
      enabled: false,
      baseUrl: '',
      model: 'whisper-small',
      language: '',
    },
    browse: {
      enabled: true,
      remoteAccess: 'admin',
    },
  },
  agent: {
    name: 'Assistant',
    workspace: 'workspace',
    maxToolRounds: 25,
    compactionThreshold: 0.75,
    softCompactionThreshold: 0.50,
    keepRecentMessages: 10,
    thinking: {
      enabled: false,
      mode: 'adaptive',
      budgetTokens: 10000,
      showThinking: { web: true, telegram: false, whatsapp: false },
    },
    showModelIndicator: { telegram: 'off', whatsapp: 'off', web: 'off' },
  },
  models: {
    capabilities: {},
  },
  mcp: {
    servers: {},
  },
};

// ──────────────────────────────────────────────
// Parse helper
// ──────────────────────────────────────────────

/**
 * Validate and parse a raw config object into a typed GatewayConfig.
 * Missing fields are filled with Zod defaults.
 */
export function parseConfig(raw: unknown): GatewayConfig {
  return configSchema.parse(raw) as unknown as GatewayConfig;
}
