import type { GatewayConfig, ProviderInterface, ProviderResponse, ChatArgs } from '@agw/types';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { createModuleLogger } from '../observability/logger.js';
import type { SecretsStore } from '../secrets/store.js';

const log = createModuleLogger('llm');

export interface ProviderInfo {
  name: string;
  authType?: string;
}

interface FailoverEvent {
  ts: string;
  from: string;
  to: string;
  error: string;
}

/**
 * Provider registry — manages LLM provider instances and failover.
 *
 * NOT a singleton: instantiated with a config object.
 * Providers are lazily initialized on first use.
 */
export class ProviderRegistry {
  private providers: Record<string, ProviderInterface> = {};
  private config: GatewayConfig;
  private initialized = false;
  private failoverLog: FailoverEvent[] = [];
  private secretsStore?: SecretsStore;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  setSecretsStore(store: SecretsStore): void {
    this.secretsStore = store;
  }

  private initProviders(): void {
    const cfg = this.config.providers;

    // Anthropic: supports API key OR OAuth/setup-token
    // Priority: SecretsStore > process.env > config (resolved from .env)
    const anthropicApiKey = this.secretsStore?.get('providers.anthropic', 'apiKey')
      || cfg.anthropic?.apiKey || '';
    const anthropicAuthToken = this.secretsStore?.get('providers.anthropic', 'authToken')
      || process.env.ANTHROPIC_AUTH_TOKEN || cfg.anthropic?.authToken || '';
    const anthropicBaseUrl = this.secretsStore?.get('providers.anthropic', 'baseUrl')
      || process.env.ANTHROPIC_BASE_URL || cfg.anthropic?.baseUrl || '';

    if (anthropicApiKey || anthropicAuthToken) {
      this.providers.anthropic = new AnthropicProvider(
        {
          apiKey: anthropicApiKey || undefined,
          authToken: anthropicAuthToken || undefined,
          baseUrl: anthropicBaseUrl || undefined,
          defaultModel: cfg.anthropic?.defaultModel || 'claude-sonnet-4-20250514',
        },
        this.config,
      );
      log.info(
        { auth: (this.providers.anthropic as AnthropicProvider).authType },
        'Anthropic provider initialized',
      );
    }

    const openaiApiKey = this.secretsStore?.get('providers.openai', 'apiKey')
      || cfg.openai?.apiKey || '';
    if (openaiApiKey) {
      this.providers.openai = new OpenAIProvider(
        {
          apiKey: openaiApiKey,
          defaultModel: cfg.openai?.defaultModel || 'gpt-4o',
        },
        this.config,
      );
      log.info('OpenAI provider initialized');
    }

    const ollamaBaseUrl = this.secretsStore?.get('providers.ollama', 'baseUrl')
      || cfg.ollama?.baseUrl || '';
    if (ollamaBaseUrl) {
      this.providers.ollama = new OpenAIProvider(
        {
          apiKey: 'ollama',
          defaultModel: cfg.ollama?.defaultModel || 'llama3',
          baseUrl: ollamaBaseUrl + '/v1',
        },
        this.config,
      );
      log.info('Ollama provider initialized');
    }

    this.initialized = true;
  }

  private ensureInitialized(): void {
    if (!this.initialized) this.initProviders();
  }

  private parseModelRef(modelRef?: string): { providerName: string; modelId: string } {
    const ref = modelRef || this.config.model.primary;
    const [providerName, ...modelParts] = ref.split('/');
    return { providerName, modelId: modelParts.join('/') };
  }

  /**
   * Get a provider and resolved model ID for a model reference.
   * Model references are "provider/model-id" or just "model-id" (uses primary).
   */
  getProvider(modelRef?: string): { provider: ProviderInterface; model: string } {
    this.ensureInitialized();

    const { providerName, modelId } = this.parseModelRef(modelRef);
    const provider = this.providers[providerName];

    if (!provider) {
      // Try fallback
      if (this.config.model.fallback) {
        const { providerName: fbName, modelId: fbModel } = this.parseModelRef(
          this.config.model.fallback,
        );
        if (this.providers[fbName]) {
          log.warn(
            { wanted: providerName, using: fbName },
            'Primary provider unavailable, using fallback',
          );
          return {
            provider: this.providers[fbName],
            model: fbModel || (this.providers[fbName] as ProviderInterface & { defaultModel?: string }).defaultModel || '',
          };
        }
      }
      throw new Error(`No provider available for "${providerName}". Configure an API key.`);
    }

    const model = modelId || (provider as ProviderInterface & { defaultModel?: string }).defaultModel || '';

    if (!model) {
      throw new Error(`No model ID resolved for "${modelRef}". Check model.primary in config.`);
    }

    return { provider, model };
  }

  /**
   * Call the LLM with automatic failover on errors.
   * If the primary provider fails (timeout, 429, 500, network error),
   * tries the fallback provider. Retries with exponential backoff on 429.
   */
  async callWithFailover(chatArgs: ChatArgs): Promise<ProviderResponse> {
    this.ensureInitialized();

    const { providerName, modelId } = this.parseModelRef(chatArgs.model);
    const primary = this.providers[providerName];
    if (!primary) {
      // will throw with helpful message
      this.getProvider(chatArgs.model);
      throw new Error('unreachable');
    }

    const model = modelId || (primary as ProviderInterface & { defaultModel?: string }).defaultModel || '';

    // Try primary
    try {
      return await this.callWithRetry(primary, { ...chatArgs, model });
    } catch (primaryErr: unknown) {
      const primaryError = primaryErr as Error;
      log.warn(
        { provider: providerName, err: primaryError.message },
        'Primary provider failed',
      );

      // Try fallback
      if (this.config.model.fallback) {
        const { providerName: fbName, modelId: fbModel } = this.parseModelRef(
          this.config.model.fallback,
        );
        const fallback = this.providers[fbName];
        if (fallback && fbName !== providerName) {
          log.info({ from: providerName, to: fbName }, 'Failing over to fallback provider');
          this.failoverLog.push({
            ts: new Date().toISOString(),
            from: providerName,
            to: fbName,
            error: primaryError.message,
          });
          // Keep only last 50 failover events
          if (this.failoverLog.length > 50) {
            this.failoverLog = this.failoverLog.slice(-50);
          }

          try {
            return await this.callWithRetry(fallback, {
              ...chatArgs,
              model: fbModel || (fallback as ProviderInterface & { defaultModel?: string }).defaultModel || '',
            });
          } catch (fbErr: unknown) {
            const fallbackError = fbErr as Error;
            log.error(
              { provider: fbName, err: fallbackError.message },
              'Fallback provider also failed',
            );
            throw fbErr;
          }
        }
      }

      throw primaryErr;
    }
  }

  /**
   * Call provider with exponential backoff retry on 429 rate limits.
   */
  private async callWithRetry(
    provider: ProviderInterface,
    chatArgs: ChatArgs,
    maxRetries = 3,
  ): Promise<ProviderResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await provider.chat(chatArgs);
      } catch (e: unknown) {
        lastErr = e;
        const err = e as Error & { status?: number };
        const is429 =
          err.status === 429 ||
          err.message?.includes('429') ||
          err.message?.includes('rate limit') ||
          err.message?.includes('Rate limit');
        if (is429 && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          log.warn(
            { attempt: attempt + 1, delay: Math.round(delay) },
            'Rate limited, retrying with backoff',
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        // Non-retryable or exhausted retries
        throw e;
      }
    }
    throw lastErr;
  }

  /**
   * Reinitialize providers from updated config.
   */
  reinitProviders(): void {
    this.providers = {};
    this.initialized = false;
    this.initProviders();
    log.info({ providers: Object.keys(this.providers) }, 'Providers reinitialized');
  }

  /**
   * List initialized provider names with info.
   */
  listProviders(): ProviderInfo[] {
    this.ensureInitialized();
    return Object.keys(this.providers).map((name) => ({ name }));
  }

  /**
   * Get the failover event log.
   */
  getFailoverLog(): FailoverEvent[] {
    return this.failoverLog;
  }
}
