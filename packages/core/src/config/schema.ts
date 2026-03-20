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
  authToken: z.string().default(''),
  baseUrl: z.string().default(''),
  defaultModel: z.string().default('claude-sonnet-4-20250514'),
  apiKeyFile: z.string().optional(),
  authTokenFile: z.string().optional(),
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

const providersSchema = z.object({
  anthropic: withObjectDefault(anthropicProviderSchema),
  openai: withObjectDefault(openaiProviderSchema),
  ollama: withObjectDefault(ollamaProviderSchema),
});

const gatewayNetworkSchema = z.object({
  port: z.number().int().min(1).max(65535).default(18181),
  host: z.string().default('0.0.0.0'),
  token: z.string().default(''),
  tokenFile: z.string().optional(),
});

const modelSelectionSchema = z.object({
  primary: z.string().default('anthropic/claude-sonnet-4-20250514'),
  fallback: z.string().default(''),
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

const toolsSchema = z.object({
  exec: withObjectDefault(execToolSchema),
  webSearch: withObjectDefault(webSearchToolSchema),
  webFetch: withObjectDefault(webFetchToolSchema),
  email: withObjectDefault(emailToolSchema),
});

const telegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(''),
  allowFrom: z.array(z.union([z.number(), z.string()])).default([]),
  groupsEnabled: z.boolean().default(true),
  groupRequireMention: z.boolean().default(true),
  tokenFile: z.string().optional(),
});

const whatsappChannelSchema = z.object({
  enabled: z.boolean().default(false),
  allowFrom: z.array(z.string()).default([]),
  groupsEnabled: z.boolean().default(true),
  groupRequireMention: z.boolean().default(true),
  groupAllowFrom: z.array(z.string()).default([]),
  sendReadReceipts: z.boolean().default(true),
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

const agentSchema = z.object({
  name: z.string().default('Assistant'),
  workspace: z.string().default('workspace'),
  maxToolRounds: z.number().int().min(1).default(25),
  compactionThreshold: z.number().min(0).max(1).default(0.75),
  keepRecentMessages: z.number().int().min(0).default(10),
  thinking: withObjectDefault(thinkingSchema),
});

const modelsCatalogSchema = z.object({
  catalog: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
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
      authToken: '${ANTHROPIC_AUTH_TOKEN}',
      baseUrl: '',
      defaultModel: 'claude-sonnet-4-20250514',
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
    primary: 'anthropic/claude-sonnet-4-20250514',
    fallback: '',
  },
  channels: {
    telegram: {
      enabled: false,
      botToken: '${TELEGRAM_BOT_TOKEN}',
      allowFrom: [],
      groupsEnabled: true,
      groupRequireMention: true,
    },
    whatsapp: {
      enabled: false,
      allowFrom: [],
      groupsEnabled: true,
      groupRequireMention: true,
      groupAllowFrom: [],
      sendReadReceipts: true,
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
  },
  agent: {
    name: 'Assistant',
    workspace: 'workspace',
    maxToolRounds: 25,
    compactionThreshold: 0.75,
    keepRecentMessages: 10,
    thinking: {
      enabled: false,
      mode: 'adaptive',
      budgetTokens: 10000,
      showThinking: { web: true, telegram: false, whatsapp: false },
    },
  },
  models: {
    catalog: {},
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
