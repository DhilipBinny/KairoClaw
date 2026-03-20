/**
 * Gateway configuration types.
 *
 * Mirrors the shape of ~/.agw/config.json (DEFAULT_CONFIG in src/config.js).
 * Environment variable references like `${VAR}` are resolved at load time,
 * so all string fields hold their resolved values at runtime.
 */

// ──────────────────────────────────────────────
// Provider configs
// ──────────────────────────────────────────────

/** Anthropic provider configuration. */
export interface AnthropicProviderConfig {
  /** API key (standard billing). Resolved from `${ANTHROPIC_API_KEY}`. */
  apiKey: string;
  /** OAuth/setup token for Claude Pro/Max subscription. */
  authToken: string;
  /** Optional proxy base URL. */
  baseUrl: string;
  /** Default model ID when none is specified. */
  defaultModel: string;
  /** Path to a file containing the API key (alternative to env var). */
  apiKeyFile?: string;
  /** Path to a file containing the auth token. */
  authTokenFile?: string;
}

/** OpenAI provider configuration. */
export interface OpenAIProviderConfig {
  /** API key. Resolved from `${OPENAI_API_KEY}`. */
  apiKey: string;
  /** Default model ID. */
  defaultModel: string;
  /** Path to a file containing the API key. */
  apiKeyFile?: string;
}

/** Ollama provider configuration. */
export interface OllamaProviderConfig {
  /** Ollama server URL. Resolved from `${OLLAMA_BASE_URL}`. */
  baseUrl: string;
  /** Default model ID. */
  defaultModel: string;
}

/** All configured LLM providers. */
export interface ProvidersConfig {
  anthropic: AnthropicProviderConfig;
  openai: OpenAIProviderConfig;
  ollama: OllamaProviderConfig;
}

// ──────────────────────────────────────────────
// Channel configs
// ──────────────────────────────────────────────

/** Telegram channel configuration. */
export interface TelegramChannelConfig {
  /** Whether the Telegram bot is enabled. */
  enabled: boolean;
  /** Bot token. Resolved from `${TELEGRAM_BOT_TOKEN}`. */
  botToken: string;
  /** Allowed user/group IDs. Empty array means no restriction. */
  allowFrom: number[];
  /** Allow group messages. */
  groupsEnabled: boolean;
  /** In groups, only respond when mentioned or replied to. */
  groupRequireMention: boolean;
  /** Path to a file containing the bot token. */
  tokenFile?: string;
  /** Outbound message policy. 'session-only' restricts to contacts with existing sessions. */
  outboundPolicy: 'session-only' | 'unrestricted';
  /** Extra chat IDs allowed for outbound beyond active sessions. */
  outboundAllowlist: string[];
}

/** WhatsApp channel configuration. */
export interface WhatsAppChannelConfig {
  /** Whether the WhatsApp channel is enabled. */
  enabled: boolean;
  /** Allowed phone numbers (E.164 format, e.g. "971501234567"). Empty = no restriction. */
  allowFrom: string[];
  /** Allow group messages. */
  groupsEnabled: boolean;
  /** In groups, only respond when mentioned. */
  groupRequireMention: boolean;
  /** Allowed group JIDs. Empty = all groups allowed. */
  groupAllowFrom: string[];
  /** Send read receipts. */
  sendReadReceipts: boolean;
  /** Outbound message policy. 'session-only' restricts to contacts with existing sessions. */
  outboundPolicy: 'session-only' | 'unrestricted';
  /** Extra JIDs allowed for outbound beyond active sessions (e.g. "6591234567@s.whatsapp.net"). */
  outboundAllowlist: string[];
}

/** All channel configurations. */
export interface ChannelsConfig {
  telegram: TelegramChannelConfig;
  whatsapp: WhatsAppChannelConfig;
}

// ──────────────────────────────────────────────
// Section configs
// ──────────────────────────────────────────────

/** Gateway network settings. */
export interface GatewayNetworkConfig {
  /** HTTP listen port. */
  port: number;
  /** Bind address. */
  host: string;
  /** Bearer token for API authentication. Resolved from `${AGW_TOKEN}`. */
  token: string;
  /** Path to a file containing the token. */
  tokenFile?: string;
}

/** Active model selection. */
export interface ModelSelectionConfig {
  /** Primary model in `provider/model-id` format (e.g. `anthropic/claude-sonnet-4-20250514`). */
  primary: string;
  /** Fallback model used when the primary fails. Empty string means no fallback. */
  fallback: string;
}

/** Session expiry settings. */
export interface SessionConfig {
  /** Hour of day (0-23) at which sessions auto-reset. */
  resetHour: number;
  /** Minutes of inactivity before session expires. 0 means disabled. */
  idleMinutes: number;
}

/** Exec tool settings. */
export interface ExecToolConfig {
  /** Whether the exec tool is enabled. */
  enabled: boolean;
  /** Default command timeout in seconds. */
  timeout: number;
}

/** Web search tool settings. */
export interface WebSearchToolConfig {
  /** Whether web search is enabled. */
  enabled: boolean;
  /** Brave Search API key. Resolved from `${BRAVE_API_KEY}`. */
  apiKey: string;
  /** Path to a file containing the API key. */
  apiKeyFile?: string;
}

/** Web fetch tool settings. */
export interface WebFetchToolConfig {
  /** Whether web fetch is enabled. */
  enabled: boolean;
  /** Maximum characters to return from a fetched page. */
  maxChars: number;
}

/** Email/SMTP tool settings. */
export interface EmailToolConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  from: string;
  allowedDomains: string[];
  allowedRecipients: string[];
  maxRecipientsPerMessage: number;
  rateLimit: {
    perMinute: number;
    perHour: number;
    perDay: number;
    perRecipientPerHour: number;
  };
}

/** Built-in tool configuration. */
export interface ToolsConfig {
  exec: ExecToolConfig;
  webSearch: WebSearchToolConfig;
  webFetch: WebFetchToolConfig;
  email: EmailToolConfig;
}



/** Per-channel visibility for thinking output. */
export interface ThinkingShowConfig {
  web: boolean;
  telegram: boolean;
  whatsapp: boolean;
}

/** Extended thinking / chain-of-thought configuration. */
export interface AgentThinkingConfig {
  /** Whether extended thinking is enabled. */
  enabled: boolean;
  /** Thinking mode: 'adaptive' lets the model decide, 'enabled' uses a fixed budget. */
  mode: 'enabled' | 'adaptive';
  /** Token budget for thinking (used when mode is 'enabled'). */
  budgetTokens: number;
  /** Per-channel visibility of thinking output. */
  showThinking: ThinkingShowConfig;
}

/** Agent behaviour configuration. */
export interface AgentConfig {
  /** Display name of the assistant. */
  name: string;
  /** Workspace directory path (resolved to absolute at runtime). */
  workspace: string;
  /** Maximum tool-call rounds per agent turn. */
  maxToolRounds: number;
  /** Context-window usage ratio that triggers compaction (0-1). */
  compactionThreshold: number;
  /** Number of recent messages to keep after compaction. */
  keepRecentMessages: number;
  /** Extended thinking / chain-of-thought configuration. */
  thinking?: AgentThinkingConfig;
}

/** User/auto-detected model capability overrides. */
export interface ModelsCatalogConfig {
  /** Model overrides keyed by model ID. */
  catalog: Record<string, Partial<import('./provider.js').ModelCapabilities>>;
}

/** MCP server configuration section. */
export interface MCPSectionConfig {
  /** MCP servers keyed by server ID. */
  servers: Record<string, import('./mcp.js').MCPServerConfig>;
}

// ──────────────────────────────────────────────
// Top-level config
// ──────────────────────────────────────────────

/**
 * Complete gateway configuration object.
 *
 * Loaded from `~/.agw/config.json` with environment variable resolution.
 * This is the runtime shape after `loadConfig()` resolves all `${VAR}` references.
 */
export interface GatewayConfig {
  gateway: GatewayNetworkConfig;
  providers: ProvidersConfig;
  model: ModelSelectionConfig;
  channels: ChannelsConfig;
  session: SessionConfig;
  tools: ToolsConfig;
  agent: AgentConfig;
  models: ModelsCatalogConfig;

  /** MCP server configuration. */
  mcp: MCPSectionConfig;

  /** Internal: resolved path to the state directory (~/.agw). Set at runtime. */
  _stateDir?: string;
}
