import type { GatewayConfig, ProviderInterface, ProviderResponse, ChatArgs, AgwLogger } from '@agw/types';
import { noopLogger, ALERT_TYPES } from '@agw/types';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { classifyError, logClassifiedError, CompactionNeededError } from './errors.js';

export interface SecretsResolver {
  get(namespace: string, key: string): string | undefined;
}

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

export type ProviderAlertFn = (event: { type: string; severity: 'critical' | 'warning'; source: string; labels: Record<string, string>; title: string; message: string }) => void;

export class ProviderRegistry {
  private providers: Record<string, ProviderInterface> = {};
  private config: GatewayConfig;
  private initPromise: Promise<void> | null = null;
  private failoverLog: FailoverEvent[] = [];
  private secretsResolver?: SecretsResolver;
  private log: AgwLogger;
  private customProviderInit?: (registry: ProviderRegistry) => Promise<void>;
  private alertEmitter?: ProviderAlertFn;

  constructor(config: GatewayConfig, logger?: AgwLogger) {
    this.config = config;
    this.log = logger ?? noopLogger;
  }

  setSecretsResolver(resolver: SecretsResolver): void {
    this.secretsResolver = resolver;
  }

  setCustomProviderInit(init: (registry: ProviderRegistry) => Promise<void>): void {
    this.customProviderInit = init;
  }

  setAlertEmitter(fn: ProviderAlertFn): void {
    this.alertEmitter = fn;
  }

  addProvider(name: string, provider: ProviderInterface): void {
    this.providers[name] = provider;
  }

  private async initProviders(): Promise<void> {
    const cfg = this.config.providers;

    const anthropicApiKey = this.secretsResolver?.get('providers.anthropic', 'apiKey')
      || cfg.anthropic?.apiKey || '';
    const anthropicBaseUrl = this.secretsResolver?.get('providers.anthropic', 'baseUrl')
      || process.env.ANTHROPIC_BASE_URL || cfg.anthropic?.baseUrl || '';

    if (anthropicApiKey) {
      this.providers.anthropic = new AnthropicProvider(
        { apiKey: anthropicApiKey, baseUrl: anthropicBaseUrl || undefined, defaultModel: cfg.anthropic?.defaultModel || 'claude-sonnet-4-6' },
        this.config,
        this.log,
      );
      this.log.info('Anthropic provider initialized (API key)');
    }

    const openaiApiKey = this.secretsResolver?.get('providers.openai', 'apiKey')
      || cfg.openai?.apiKey || '';
    const openaiBaseUrl = this.secretsResolver?.get('providers.openai', 'baseUrl')
      || cfg.openai?.baseUrl || '';
    if (openaiApiKey || openaiBaseUrl) {
      this.providers.openai = new OpenAIProvider(
        { apiKey: openaiApiKey, baseUrl: openaiBaseUrl || undefined, defaultModel: cfg.openai?.defaultModel || 'gpt-4o' },
        this.config,
        this.log,
      );
      this.log.info({ hasBaseUrl: !!openaiBaseUrl }, 'OpenAI provider initialized');
    }

    const ollamaBaseUrl = this.secretsResolver?.get('providers.ollama', 'baseUrl')
      || cfg.ollama?.baseUrl || '';
    if (ollamaBaseUrl) {
      this.providers.ollama = new OpenAIProvider(
        { apiKey: 'ollama', defaultModel: cfg.ollama?.defaultModel || 'llama3', baseUrl: ollamaBaseUrl + '/v1' },
        this.config,
        this.log,
      );
      this.log.info('Ollama provider initialized');
    }

    if (this.customProviderInit) {
      await this.customProviderInit(this);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initProviders();
    }
    await this.initPromise;
  }

  async hasProvider(providerPrefix: string): Promise<boolean> {
    await this.ensureInitialized();
    return !!this.providers[providerPrefix];
  }

  /** Synchronous check — only valid after ensureInitialized() has completed. */
  hasProviderSync(providerPrefix: string): boolean {
    return !!this.providers[providerPrefix];
  }

  private parseModelRef(modelRef?: string): { providerName: string; modelId: string } {
    const ref = modelRef || this.config.model.primary;
    const [providerName, ...modelParts] = ref.split('/');
    return { providerName, modelId: modelParts.join('/') };
  }

  async getProvider(modelRef?: string): Promise<{ provider: ProviderInterface; model: string }> {
    await this.ensureInitialized();

    const { providerName, modelId } = this.parseModelRef(modelRef);
    const provider = this.providers[providerName];

    if (!provider) {
      if (this.config.model.fallback) {
        const { providerName: fbName, modelId: fbModel } = this.parseModelRef(this.config.model.fallback);
        if (this.providers[fbName]) {
          this.log.warn({ wanted: providerName, using: fbName }, 'Primary provider unavailable, using fallback');
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

  async callWithFailover(chatArgs: ChatArgs): Promise<ProviderResponse> {
    await this.ensureInitialized();

    // Don't start (or fail over) a request that's already been cancelled (#181).
    if (chatArgs.signal?.aborted) throw new Error('Request aborted');

    const { providerName, modelId } = this.parseModelRef(chatArgs.model);
    const primary = this.providers[providerName];

    // Primary unconfigured (no API key): walk the fallback chain instead of
    // failing. Previously this threw 'unreachable' before any fallback ran (#183).
    if (!primary) {
      this.log.warn({ wanted: providerName }, 'Primary provider unconfigured — trying fallback chain');
      return await this.runFallbackChain(
        chatArgs,
        providerName,
        new Error(`No provider available for "${providerName}". Configure an API key.`),
      );
    }

    const model = modelId || (primary as ProviderInterface & { defaultModel?: string }).defaultModel || '';

    try {
      const resp = await this.callWithRetry(primary, { ...chatArgs, model });
      resp.servedModel = `${providerName}/${model}`;
      return resp;
    } catch (primaryErr: unknown) {
      // compact_and_retry should NOT trigger failover — re-throw for agent loop
      if (primaryErr instanceof CompactionNeededError) {
        this.log.info({ provider: providerName }, 'Context too long, needs compaction — skipping failover');
        throw primaryErr;
      }

      // If the caller cancelled, surface that immediately rather than burning a
      // full fallback generation that ignores the (already-fired) signal (#181).
      if (chatArgs.signal?.aborted) throw primaryErr;

      const primaryError = primaryErr as Error;
      this.log.warn({ provider: providerName, err: primaryError.message }, 'Primary provider failed');
      return await this.runFallbackChain(chatArgs, providerName, primaryError);
    }
  }

  /**
   * Try each configured fallback provider in order, returning the first success
   * and stamping the response with the provider/model that actually served it.
   * Used both when the primary is unconfigured and when it fails (#183). Throws
   * the last error (or the supplied primary error) if none succeed.
   */
  private async runFallbackChain(
    chatArgs: ChatArgs,
    excludeProvider: string,
    primaryError: Error,
  ): Promise<ProviderResponse> {
    const chain = this.config.model.fallbackChain?.length
      ? this.config.model.fallbackChain
      : this.config.model.fallback ? [this.config.model.fallback] : [];

    let lastError = primaryError;
    for (let i = 0; i < chain.length; i++) {
      const fbRef = chain[i];
      if (!fbRef) continue;
      // Respect mid-chain cancellation rather than burning another generation.
      if (chatArgs.signal?.aborted) throw lastError;

      const { providerName: fbName, modelId: fbModel } = this.parseModelRef(fbRef);
      const fallback = this.providers[fbName];
      if (!fallback || fbName === excludeProvider) continue;

      const fbResolvedModel = fbModel || (fallback as ProviderInterface & { defaultModel?: string }).defaultModel || '';
      this.log.info({ from: excludeProvider, to: fbName, attempt: i + 1 }, 'Failing over to next provider');
      this.failoverLog.push({ ts: new Date().toISOString(), from: excludeProvider, to: fbName, error: primaryError.message });
      if (this.failoverLog.length > 50) {
        this.failoverLog = this.failoverLog.slice(-50);
      }

      try {
        const resp = await this.callWithRetry(fallback, { ...chatArgs, model: fbResolvedModel });
        resp.servedModel = `${fbName}/${fbResolvedModel}`;
        return resp;
      } catch (fbErr: unknown) {
        // Compaction needs must propagate, not be swallowed as a failover miss.
        if (fbErr instanceof CompactionNeededError) throw fbErr;
        lastError = fbErr as Error;
        this.log.warn({ provider: fbName, err: lastError.message }, 'Fallback provider failed, trying next');
      }
    }

    // Everything failed. Emit alert for all-providers-down.
    this.alertEmitter?.({
      type: ALERT_TYPES.PROVIDER_ALL_DOWN,
      severity: 'critical',
      source: 'provider-bridge',
      labels: { source: 'provider-bridge', primary: excludeProvider },
      title: 'All LLM providers failed',
      message: `Primary (${excludeProvider}) and all fallbacks failed: ${lastError.message}`,
    });

    // Prefer the primary error when it is an actionable config problem
    // (e.g. a bad/missing API key) so the user still sees the "check your
    // API key" message rather than a transient fallback error.
    if (classifyError(primaryError).type === 'auth_error') throw primaryError;
    throw lastError;
  }

  private async callWithRetry(
    provider: ProviderInterface,
    chatArgs: ChatArgs,
    maxRetries = 3,
  ): Promise<ProviderResponse> {
    let hasStreamed = false;
    const wrappedArgs: ChatArgs = {
      ...chatArgs,
      onDelta: chatArgs.onDelta
        ? (delta: string) => { hasStreamed = true; chatArgs.onDelta!(delta); }
        : undefined,
      onThinkingDelta: chatArgs.onThinkingDelta
        ? (delta: string) => { hasStreamed = true; chatArgs.onThinkingDelta!(delta); }
        : undefined,
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await provider.chat(wrappedArgs);
      } catch (e: unknown) {
        lastErr = e;
        const classified = classifyError(e, attempt);
        logClassifiedError(classified, { provider: provider.name, attempt, maxRetries });

        if (hasStreamed) {
          this.log.warn({ provider: provider.name, attempt }, 'Mid-stream failure — skipping retry to prevent duplicate output');
          throw e;
        }

        if (classified.type === 'auth_error') {
          this.alertEmitter?.({
            type: ALERT_TYPES.PROVIDER_AUTH_ERROR,
            severity: 'critical',
            source: 'provider-bridge',
            labels: { source: 'provider-bridge', provider: provider.name },
            title: `Provider auth failed: ${provider.name}`,
            message: classified.message || 'Authentication failed — check API key',
          });
        }

        if (classified.retriable && attempt < maxRetries) {
          if (classified.action === 'compact_and_retry') {
            throw new CompactionNeededError(e); // signal agent loop to compact, not failover
          }
          if (classified.action === 'failover') {
            throw e; // handled by outer callWithFailover
          }
          if (classified.retryDelayMs > 0) {
            // Abort-aware backoff: a Stop/kill during the delay returns at once
            // instead of waiting out the (possibly large Retry-After) sleep (#181).
            await new Promise<void>((resolve) => {
              const sig = chatArgs.signal;
              if (sig?.aborted) return resolve();
              const t = setTimeout(() => { sig?.removeEventListener('abort', onAbort); resolve(); }, classified.retryDelayMs);
              const onAbort = () => { clearTimeout(t); resolve(); };
              sig?.addEventListener('abort', onAbort, { once: true });
            });
            if (chatArgs.signal?.aborted) throw e;
          }
          continue;
        }

        throw e;
      }
    }
    throw lastErr;
  }

  async reinitProviders(): Promise<void> {
    this.providers = {};
    this.initPromise = null;
    await this.ensureInitialized();
    this.log.info({ providers: Object.keys(this.providers) }, 'Providers reinitialized');
  }

  async listProviders(): Promise<ProviderInfo[]> {
    await this.ensureInitialized();
    return Object.keys(this.providers).map((name) => ({ name }));
  }

  getFailoverLog(): FailoverEvent[] {
    return this.failoverLog;
  }
}
