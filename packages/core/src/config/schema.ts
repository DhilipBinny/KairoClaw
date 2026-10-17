import { z } from 'zod';
import type { GatewayConfig } from '@agw/types';
import {
  ALERT_GROUP_WAIT_MS, ALERT_COOLDOWN_CRITICAL_MS, ALERT_COOLDOWN_WARNING_MS,
  ALERT_REPEAT_CRITICAL_MS, ALERT_REPEAT_WARNING_MS, ALERT_RESOLUTION_DELAY_MS,
  ALERT_FAILURE_THRESHOLD, ALERT_RECOVERY_THRESHOLD,
} from '../constants.js';

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
  baseUrl: z.string().default(''),
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
  trustProxy: z.union([z.boolean(), z.number(), z.string()]).default(false),
});

const modelSelectionSchema = z.object({
  primary: z.string().default('anthropic/claude-sonnet-4-6').transform(v => v.replace(/[^\w\-.:/@]/g, '').slice(0, 100)),
  fallback: z.string().default('').transform(v => v.replace(/[^\w\-.:/@]/g, '').slice(0, 100)),
  fallbackChain: z.array(z.string()).optional(),
});

const sessionSchema = z.object({
  resetHour: z.number().int().min(0).max(23).default(4),
  idleMinutes: z.number().int().min(0).default(60),
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
  /**
   * Phase 12: hosts (or host:port) that bypass SSRF protection.
   * Typically used for local dev servers — e.g.
   *   allowPrivate: ["localhost:3000", "127.0.0.1:5173"]
   * so the agent can fetch its own running dev server without being
   * blocked by the private-IP guard. Leave empty (the default) for
   * the full SSRF lockdown.
   *
   * ⚠️ This allowlist is GLOBAL — it applies to every user, not just
   * admins. Once `localhost:3000` is in the list, any non-admin user
   * (telegram, whatsapp, web) can also fetch it via web_fetch. Only
   * add hosts you are willing to expose to every channel and every
   * user that has access to web_fetch on this server.
   */
  allowPrivate: z.array(z.string()).default([]),
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

const sandboxCapabilitiesSchema = z.object({
  network: z.enum(['open', 'balanced', 'locked']).optional(),
  workspace: z.enum(['read-write', 'read-only', 'none']).optional(),
  escalation: z.enum(['auto', 'confirm', 'deny']).optional(),
  cpu: z.number().min(0.5).max(16).optional(),
  memoryMb: z.number().int().min(128).max(32768).optional(),
  timeoutSeconds: z.number().int().min(10).max(600).optional(),
});

const safeDomainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

const sandboxToolSchema = z.object({
  enabled: z.boolean().default(false),
  image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._\-/:]*$/).default('kairoclaw-sandbox:full'),
  dockerSocket: z.string().default('/var/run/docker.sock'),
  defaults: withObjectDefault(z.object({
    network: z.enum(['open', 'balanced', 'locked']).default('balanced'),
    workspace: z.enum(['read-write', 'read-only', 'none']).default('read-write'),
    escalation: z.enum(['auto', 'confirm', 'deny']).default('confirm'),
    cpu: z.number().min(0.5).max(16).default(1),
    memoryMb: z.number().int().min(128).max(32768).default(512),
    timeoutSeconds: z.number().int().min(10).max(600).default(120),
    maxLifetimeMinutes: z.number().int().min(10).max(1440).default(240),
    pidsLimit: z.number().int().min(32).max(4096).default(256),
  })),
  networkAllowlist: z.array(z.string().regex(safeDomainRegex)).default([
    'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org',
    'deb.debian.org', 'security.debian.org',
    'github.com', 'gitlab.com',
    'api.openai.com', 'api.anthropic.com',
  ]),
  roles: z.record(z.string(), sandboxCapabilitiesSchema).default({}),
  userOverrides: z.record(z.string(), sandboxCapabilitiesSchema).default({}),
});

const toolsSchema = z.object({
  exec: withObjectDefault(execToolSchema),
  webSearch: withObjectDefault(webSearchToolSchema),
  webFetch: withObjectDefault(webFetchToolSchema),
  email: withObjectDefault(emailToolSchema),
  transcription: withObjectDefault(transcriptionToolSchema),
  browse: withObjectDefault(browseToolSchema),
  sandbox: withObjectDefault(sandboxToolSchema),
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

/**
 * Tuning knobs for the memory_search composite scorer.
 * - `profileBoost`: PROFILE.md chunks are multiplied by this score.
 *   Default 1.5 (50% boost over session notes). Must be > 0.
 * - `recencyHalfLifeDays`: chunks decay to half their keyword score
 *   after this many days. Default 14 days. Must be > 0.
 *
 * Both are optional — omit to use the defaults baked into
 * `MemorySystem`.
 */
const memorySchema = z.object({
  profileBoost: z.number().positive().optional(),
  recencyHalfLifeDays: z.number().positive().optional(),
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
  fastModel: z.string().default(''),
  powerfulModel: z.string().default(''),
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

const responseFormatSchema = z.object({
  type: z.enum(['none', 'json_object']).default('none'),
});

const debugSchema = z.object({
  recordPrompt: z.boolean().default(false),
});

const budgetEnforcementSchema = z.enum(['block', 'downgrade', 'alert']).default('downgrade');

const budgetSchema = z.object({
  dailyCapUsd: z.number().min(0).default(0),
  monthlyCapUsd: z.number().min(0).default(0),
  enforcement: budgetEnforcementSchema,
  downgradeModel: z.string().default(''),
  alertThresholds: z.array(z.number().min(0).max(100)).default([80, 95]),
});

const agentSchema = z.object({
  name: z.string().default('Assistant').transform(v => v.replace(/[^\w \-'.]/g, '').slice(0, 50)),
  timezone: z.string().default('UTC').transform((tz) => {
    try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return tz; } catch { return 'UTC'; }
  }),
  workspace: z.string().default('workspace'),
  maxToolRounds: z.number().int().min(1).default(25),
  compactionThreshold: z.number().min(0).max(1).default(0.75),
  softCompactionThreshold: z.number().min(0).max(1).default(0.50),
  keepRecentMessages: z.number().int().min(0).default(10),
  /**
   * Phase 8: deferred tool loading. When true (the default), the
   * initial tool surface shown to the LLM is just the `alwaysLoad`
   * core set; every other tool is hidden until the agent calls
   * `tool_search` to load it for the current session. This cuts
   * per-turn prompt-token cost substantially once the tool surface
   * grows past a dozen or so tools. Set to false to always send
   * every tool's full definition (pre-Phase-8 behaviour). Also
   * overridable via `AGW_DEFER_TOOLS=false` env var.
   */
  deferToolLoading: z.boolean().default(false),
  thinking: withObjectDefault(thinkingSchema),
  sessionMemory: withObjectDefault(sessionMemorySchema),
  memory: withObjectDefault(memorySchema),
  contextInjection: withObjectDefault(contextInjectionSchema),
  routing: withObjectDefault(routingSchema),
  showModelIndicator: withObjectDefault(modelIndicatorSchema),
  maxBackgroundTasks: z.number().int().min(1).default(10),
  budget: withObjectDefault(budgetSchema),
  piiRedaction: z.boolean().default(false),
  toolTimeout: z.number().int().min(0).default(120),
  responseFormat: withObjectDefault(responseFormatSchema),
  debug: withObjectDefault(debugSchema),
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
  supportsStructuredOutput: z.boolean().default(false),
  displayName: z.string().optional(),
  source: z.enum(['auto', 'manual']).default('auto'),
}).partial();

const modelsCatalogSchema = z.object({
  capabilities: z.record(z.string(), modelCapabilityEntrySchema).default({}),
});

const mcpServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  transport: z.enum(['stdio', 'sse', 'streamable-http']).default('stdio'),
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

// ── Plugin schemas — imported from @agw/schemas (shared with @agw/plugins) ──
export { pluginsSchema } from '@agw/schemas';

// ── Phase 12 hooks ───────────────────────────────────────
const toolHookSchema = z.object({
  matcher: z.string(),
  command: z.string(),
  timeoutMs: z.number().int().min(1).optional(),
});
const sessionHookSchema = z.object({
  command: z.string(),
  timeoutMs: z.number().int().min(1).optional(),
});
const hooksSchema = z.object({
  PreToolUse: z.array(toolHookSchema).default([]),
  PostToolUse: z.array(toolHookSchema).default([]),
  SessionStart: z.array(sessionHookSchema).default([]),
  PostCompact: z.array(sessionHookSchema).default([]),
});

const alertEventOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  severity: z.enum(['critical', 'warning']).optional(),
  delivery: z.array(z.string()).optional(),
  failureThreshold: z.number().int().min(1).optional(),
  recoveryThreshold: z.number().int().min(1).optional(),
});

const alertsSchema = z.object({
  enabled: z.boolean().default(false),
  delivery: withObjectDefault(z.object({
    telegram: withObjectDefault(z.object({
      enabled: z.boolean().default(true),
      chatIds: z.array(z.string()).default([]),
    })),
    whatsapp: withObjectDefault(z.object({
      enabled: z.boolean().default(false),
      jids: z.array(z.string()).default([]),
    })),
    websocket: withObjectDefault(z.object({
      enabled: z.boolean().default(true),
    })),
    webhook: withObjectDefault(z.object({
      enabled: z.boolean().default(false),
      urls: z.array(z.string().url()).default([]),
      secret: z.string().default(''),
    })),
  })),
  timing: withObjectDefault(z.object({
    groupWaitMs: z.number().int().min(0).default(ALERT_GROUP_WAIT_MS),
    cooldownCriticalMs: z.number().int().min(0).default(ALERT_COOLDOWN_CRITICAL_MS),
    cooldownWarningMs: z.number().int().min(0).default(ALERT_COOLDOWN_WARNING_MS),
    repeatCriticalMs: z.number().int().min(0).default(ALERT_REPEAT_CRITICAL_MS),
    repeatWarningMs: z.number().int().min(0).default(ALERT_REPEAT_WARNING_MS),
    resolutionDelayMs: z.number().int().min(0).default(ALERT_RESOLUTION_DELAY_MS),
  })),
  thresholds: withObjectDefault(z.object({
    failureThreshold: z.number().int().min(1).default(ALERT_FAILURE_THRESHOLD),
    recoveryThreshold: z.number().int().min(1).default(ALERT_RECOVERY_THRESHOLD),
  })),
  events: z.record(z.string(), alertEventOverrideSchema).default({}),
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
  hooks: withObjectDefault(hooksSchema),
  alerts: withObjectDefault(alertsSchema),
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
      baseUrl: '',
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
    idleMinutes: 60,
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
    sandbox: {
      enabled: false,
      image: 'kairoclaw-sandbox:full',
      dockerSocket: '/var/run/docker.sock',
      defaults: {
        network: 'balanced',
        workspace: 'read-write',
        escalation: 'confirm',
        cpu: 1,
        memoryMb: 512,
        timeoutSeconds: 120,
        maxLifetimeMinutes: 240,
        pidsLimit: 256,
      },
      networkAllowlist: [
        'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org',
        'deb.debian.org', 'security.debian.org',
        'github.com', 'gitlab.com',
        'api.openai.com', 'api.anthropic.com',
      ],
      roles: {},
      userOverrides: {},
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
    debug: { recordPrompt: false },
  },
  models: {
    capabilities: {},
  },
  mcp: {
    servers: {},
  },
  alerts: {
    enabled: false,
    delivery: {
      telegram: { enabled: true, chatIds: [] },
      whatsapp: { enabled: false, jids: [] },
      websocket: { enabled: true },
      webhook: { enabled: false, urls: [], secret: '' },
    },
    timing: {
      groupWaitMs: ALERT_GROUP_WAIT_MS,
      cooldownCriticalMs: ALERT_COOLDOWN_CRITICAL_MS,
      cooldownWarningMs: ALERT_COOLDOWN_WARNING_MS,
      repeatCriticalMs: ALERT_REPEAT_CRITICAL_MS,
      repeatWarningMs: ALERT_REPEAT_WARNING_MS,
      resolutionDelayMs: ALERT_RESOLUTION_DELAY_MS,
    },
    thresholds: {
      failureThreshold: ALERT_FAILURE_THRESHOLD,
      recoveryThreshold: ALERT_RECOVERY_THRESHOLD,
    },
    events: {},
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
