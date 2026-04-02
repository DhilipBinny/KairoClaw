import type { GatewayConfig, ProviderInterface, ProviderResponse, ChatArgs } from '@agw/types';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { classifyError, logClassifiedError } from './errors.js';
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

      // Build fallback chain: prefer explicit chain, fall back to single fallback
      const chain = this.config.model.fallbackChain?.length
        ? this.config.model.fallbackChain
        : this.config.model.fallback ? [this.config.model.fallback] : [];

      for (const fbRef of chain) {
        if (!fbRef) continue;
        const { providerName: fbName, modelId: fbModel } = this.parseModelRef(fbRef);
        const fallback = this.providers[fbName];
        if (!fallback || fbName === providerName) continue;

        log.info({ from: providerName, to: fbName, attempt: chain.indexOf(fbRef) + 1 }, 'Failing over to next provider');
        this.failoverLog.push({
          ts: new Date().toISOString(),
          from: providerName,
          to: fbName,
          error: primaryError.message,
        });
        if (this.failoverLog.length > 50) {
          this.failoverLog = this.failoverLog.slice(-50);
        }

        try {
          return await this.callWithRetry(fallback, {
            ...chatArgs,
            model: fbModel || (fallback as ProviderInterface & { defaultModel?: string }).defaultModel || '',
          });
        } catch (fbErr: unknown) {
          log.warn(
            { provider: fbName, err: (fbErr as Error).message },
            'Fallback provider failed, trying next',
          );
          // Continue to next in chain
        }
      }

      throw primaryErr;
    }
  }

  /**
   * Call provider with classified error handling and retry logic.
   *
   * Uses the centralized error classifier to decide: retry with backoff,
   * retry immediately (stale connection), or throw (let callWithFailover
   * handle failover).
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
        const classified = classifyError(e, attempt);
        logClassifiedError(classified, { provider: provider.name, attempt, maxRetries });

        // Only retry on retriable errors within attempt budget
        if (classified.retriable && attempt < maxRetries) {
          if (classified.action === 'retry_with_backoff' || classified.action === 'retry_immediately') {
            if (classified.retryDelayMs > 0) {
              await new Promise((r) => setTimeout(r, classified.retryDelayMs));
            }
            continue;
          }
        }

        // Non-retriable or exhausted retries — throw for failover handling
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
