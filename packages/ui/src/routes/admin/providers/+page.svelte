<script lang="ts">
  import { onMount } from 'svelte';
  import { getConfig, testProvider, updateConfig, saveProviderCredentials, getModelInfo, saveModelCapabilities, getProviderStatus, refreshModelCapabilities, getAllModelCapabilities } from '$lib/api';
  import type { ModelInfo, ProviderStatus } from '$lib/api';
  import Badge from '$lib/components/Badge.svelte';

  interface ProviderConfig {
    apiKey?: string;
    authToken?: string;
    baseUrl?: string;
  }

  interface ModelCaps {
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsVision?: boolean;
    supportsToolCalling?: boolean;
    supportsStreaming?: boolean;
    costPer1M?: { input: number; output: number } | null;
    timeoutMs?: number;
  }

  interface Model {
    id: string;
    name: string;
    capabilities?: ModelCaps;
  }

  interface TestResult {
    success: boolean;
    models?: Model[];
    error?: string;
    authType?: string;
  }

  let config: Record<string, unknown> | null = $state(null);
  let loading = $state(true);
  let testingProvider: Record<string, boolean> = $state({});
  let testResults: Record<string, TestResult | null> = $state({});
  let savingModel = $state('');
  let premiumToggleWarning = $state('');
  let saveMessage = $state('');
  let providerStatus: Record<string, ProviderStatus> = $state({});

  // Active model info (capabilities for top card)
  let primaryModel: ModelInfo | null = $state(null);
  let fallbackModel: ModelInfo | null = $state(null);

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
    return `${n}`;
  }

  function formatCost(cost: { input: number; output: number }): string {
    return `$${cost.input}/$${cost.output}`;
  }

  // Capability edit state
  let editingCaps: string | null = $state(null); // model ID being edited
  let editingCapsProvider = $state('');
  let capsForm = $state<Record<string, unknown>>({});
  let savingCaps = $state(false);
  let capsMsg = $state('');
  /** When set, saving caps will also set this model as default/fallback after save. */
  let pendingModelAction: { type: 'default' | 'fallback'; providerId: string; modelId: string } | null = $state(null);

  // ── Model Capabilities section state ──
  interface CapEntry {
    id: string;
    displayName?: string;
    provider?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsVision?: boolean;
    supportsThinking?: boolean;
    supportsToolCalling?: boolean;
    timeoutMs?: number;
    costPer1M?: { input: number; output: number } | null;
    source?: 'auto' | 'manual';
  }
  let allCapabilities: CapEntry[] = $state([]);
  let loadingCaps = $state(false);
  let refreshingCaps = $state(false);
  let capsFilter = $state('');
  let editingCapId: string | null = $state(null);
  let capEditForm = $state<Record<string, unknown>>({});
  let savingCapEdit = $state(false);
  let capEditMsg = $state('');

  async function loadCapabilities() {
    loadingCaps = true;
    try {
      const data = await getAllModelCapabilities();
      allCapabilities = Object.entries(data.capabilities || {}).map(([id, caps]) => ({
        id,
        ...(caps as Record<string, unknown>),
      })) as CapEntry[];
    } catch { allCapabilities = []; }
    loadingCaps = false;
  }

  let refreshMsg = $state('');
  async function handleRefreshCaps() {
    refreshingCaps = true;
    refreshMsg = '';
    try {
      const result = await refreshModelCapabilities();
      allCapabilities = Object.entries(result.capabilities || {}).map(([id, caps]) => ({
        id,
        ...(caps as Record<string, unknown>),
      })) as CapEntry[];
      refreshMsg = `Refreshed: ${result.fetched} models from ${result.providers?.join(', ') || 'none'}`;
      await loadModelInfo();
    } catch (e) {
      refreshMsg = `Refresh failed: ${e instanceof Error ? e.message : 'Unknown error'}`;
    }
    refreshingCaps = false;
  }

  function startCapEdit(entry: CapEntry) {
    editingCapId = entry.id;
    capEditForm = {
      contextWindow: entry.contextWindow || 128000,
      maxOutputTokens: entry.maxOutputTokens || 8192,
      supportsVision: entry.supportsVision ?? true,
      supportsThinking: entry.supportsThinking ?? false,
      supportsToolCalling: entry.supportsToolCalling ?? true,
      timeoutMs: entry.timeoutMs || 120000,
      costInputPerM: entry.costPer1M?.input ?? '',
      costOutputPerM: entry.costPer1M?.output ?? '',
    };
    capEditMsg = '';
  }

  async function saveCapEdit() {
    if (!editingCapId) return;
    savingCapEdit = true;
    try {
      const costInput = Number(capEditForm.costInputPerM);
      const costOutput = Number(capEditForm.costOutputPerM);
      const caps: Record<string, unknown> = {
        contextWindow: Number(capEditForm.contextWindow),
        maxOutputTokens: Number(capEditForm.maxOutputTokens),
        supportsVision: capEditForm.supportsVision,
        supportsThinking: capEditForm.supportsThinking,
        supportsToolCalling: capEditForm.supportsToolCalling,
        timeoutMs: Number(capEditForm.timeoutMs),
        costPer1M: (costInput > 0 && costOutput > 0) ? { input: costInput, output: costOutput } : null,
      };
      await saveModelCapabilities(editingCapId, caps);
      capEditMsg = 'Saved';
      editingCapId = null;
      await loadCapabilities();
      await loadModelInfo();
    } catch (e) {
      capEditMsg = e instanceof Error ? e.message : 'Failed';
    }
    savingCapEdit = false;
  }

  function filteredCapabilities(): CapEntry[] {
    if (!capsFilter) return allCapabilities;
    const f = capsFilter.toLowerCase();
    return allCapabilities.filter(c =>
      c.id.toLowerCase().includes(f) ||
      (c.displayName || '').toLowerCase().includes(f) ||
      (c.provider || '').toLowerCase().includes(f)
    );
  }

  /** Check if a model has verified capabilities (in master list or user overrides). */
  function hasKnownCaps(caps?: ModelCaps): boolean {
    if (!caps) return false;
    // If provider is 'unknown' and contextWindow is the default 128000, it's unverified
    return !!((caps as Record<string, unknown>).provider && (caps as Record<string, unknown>).provider !== 'unknown');
  }

  function startEditCaps(providerId: string, modelId: string, caps: ModelCaps, action?: 'default' | 'fallback') {
    editingCaps = modelId;
    editingCapsProvider = providerId;
    capsForm = {
      contextWindow: caps.contextWindow || 0,
      maxOutputTokens: caps.maxOutputTokens || 0,
      supportsVision: caps.supportsVision ?? false,
      supportsToolCalling: caps.supportsToolCalling ?? false,
      timeoutMs: caps.timeoutMs || 120000,
    };
    capsMsg = action ? 'Configure capabilities before activating this model.' : '';
    pendingModelAction = action ? { type: action, providerId, modelId } : null;
  }

  async function handleSaveCaps() {
    if (!editingCaps) return;
    savingCaps = true;
    try {
      await saveModelCapabilities(editingCaps, { ...capsForm, provider: editingCapsProvider });
      // If there's a pending action (set as default/fallback), execute it now
      if (pendingModelAction) {
        const { type, providerId, modelId } = pendingModelAction;
        if (type === 'default') {
          await handleSetDefault(providerId, modelId);
        } else {
          await handleSetFallback(providerId, modelId);
        }
        pendingModelAction = null;
      }
      capsMsg = 'Saved';
      await loadModelInfo();
      editingCaps = null;
    } catch (e: unknown) {
      capsMsg = e instanceof Error ? e.message : 'Failed to save';
    } finally {
      savingCaps = false;
    }
  }

  // Password visibility
  let showPassword: Record<string, boolean> = $state({});

  // Credential form state
  let showCredForm: Record<string, boolean> = $state({});
  let credForm: Record<string, Record<string, string>> = $state({});
  let savingCred = $state('');
  let credMsg: Record<string, { text: string; ok: boolean }> = $state({});

  // ── Routing state ──
  let showRouting = $state(false);
  let routingEnabled = $state(false);
  let routingFastModel = $state('anthropic/claude-haiku-4-5-20251001');
  let routingPowerfulModel = $state('anthropic/claude-opus-4-6');
  let routingLlmClassifier = $state(true);
  let routingShortThreshold = $state(50);
  let routingOpusPatterns = $state('');
  let routingHaikuPatterns = $state('');
  let routingSaving = $state(false);
  let routingMsg = $state('');

  function loadRoutingState() {
    const routing = (config?.agent as Record<string, unknown>)?.routing as Record<string, unknown> | undefined;
    if (routing) {
      routingEnabled = routing.enabled === true;
      if (routing.fastModel) routingFastModel = routing.fastModel as string;
      if (routing.powerfulModel) routingPowerfulModel = routing.powerfulModel as string;
      if (routing.llmClassifier !== undefined) routingLlmClassifier = routing.llmClassifier as boolean;
      if (routing.shortMessageThreshold !== undefined) routingShortThreshold = routing.shortMessageThreshold as number;
      if (Array.isArray(routing.opusPatterns)) routingOpusPatterns = (routing.opusPatterns as string[]).join('\n');
      if (Array.isArray(routing.haikuPatterns)) routingHaikuPatterns = (routing.haikuPatterns as string[]).join('\n');
    }
  }

  async function saveRouting() {
    routingSaving = true;
    routingMsg = '';
    try {
      await updateConfig('agent.routing.enabled', routingEnabled);
      await updateConfig('agent.routing.fastModel', routingFastModel);
      await updateConfig('agent.routing.powerfulModel', routingPowerfulModel);
      await updateConfig('agent.routing.llmClassifier', routingLlmClassifier);
      await updateConfig('agent.routing.shortMessageThreshold', routingShortThreshold);
      await updateConfig('agent.routing.opusPatterns', routingOpusPatterns.split('\n').map((s: string) => s.trim()).filter(Boolean));
      await updateConfig('agent.routing.haikuPatterns', routingHaikuPatterns.split('\n').map((s: string) => s.trim()).filter(Boolean));
      routingMsg = 'Saved';
      setTimeout(() => routingMsg = '', 2000);
    } catch (e: unknown) {
      routingMsg = e instanceof Error ? e.message : 'Save failed';
    }
    routingSaving = false;
  }

  const providers = [
    { id: 'anthropic', name: 'Anthropic', description: 'Claude models (Sonnet, Opus, Haiku)', color: 'var(--accent)' },
    { id: 'openai', name: 'OpenAI', description: 'GPT-4, o1, o3, o4 models', color: 'var(--green)' },
    { id: 'ollama', name: 'Ollama', description: 'Local models via Ollama', color: 'var(--agent)' },
  ];

  function getCurrentModel(): string {
    const model = config?.model as Record<string, unknown> | undefined;
    return (model?.primary as string) || 'Not set';
  }

  function getFallbackModel(): string {
    const model = config?.model as Record<string, unknown> | undefined;
    return (model?.fallback as string) || 'Not set';
  }

  function getProviderConfig(id: string): ProviderConfig | null {
    const prov = config?.providers as Record<string, ProviderConfig> | undefined;
    return prov?.[id] || null;
  }

  function isConfigured(id: string): boolean {
    return providerStatus[id]?.configured ?? false;
  }

  function getBadgeVariant(providerId: string): 'green' | 'yellow' | 'default' {
    if (testResults[providerId]?.success) return 'green';
    if (isConfigured(providerId)) return 'yellow';
    return 'default';
  }

  function getBadgeLabel(providerId: string): string {
    if (testResults[providerId]?.success) return 'Connected';
    if (isConfigured(providerId)) return 'Configured';
    return 'Not configured';
  }

  async function handleTest(providerId: string) {
    testingProvider[providerId] = true;
    testResults[providerId] = null;
    saveMessage = '';
    try {
      const result = await testProvider({ provider: providerId, useExisting: true });
      testResults[providerId] = result;
    } catch (e: unknown) {
      testResults[providerId] = { success: false, error: e instanceof Error ? e.message : 'Test failed' };
    } finally {
      testingProvider[providerId] = false;
    }
  }

  async function handleSetDefault(providerId: string, modelId: string) {
    const fullRef = `${providerId}/${modelId}`;
    savingModel = modelId;
    saveMessage = '';
    try {
      await updateConfig('model.primary', fullRef);
      if (config) {
        const model = (config.model || {}) as Record<string, unknown>;
        model.primary = fullRef;
        config.model = model;
        config = { ...config };
      }
      saveMessage = `Default model set to ${fullRef}`;
      loadModelInfo();
    } catch (e: unknown) {
      saveMessage = `Failed to save: ${e instanceof Error ? e.message : 'Unknown error'}`;
    } finally {
      savingModel = '';
    }
  }

  async function handleSetFallback(providerId: string, modelId: string) {
    const fullRef = `${providerId}/${modelId}`;
    savingModel = modelId;
    saveMessage = '';
    try {
      await updateConfig('model.fallback', fullRef);
      if (config) {
        const model = (config.model || {}) as Record<string, unknown>;
        model.fallback = fullRef;
        config.model = model;
        config = { ...config };
      }
      saveMessage = `Fallback model set to ${fullRef}`;
      loadModelInfo();
    } catch (e: unknown) {
      saveMessage = `Failed to save: ${e instanceof Error ? e.message : 'Unknown error'}`;
    } finally {
      savingModel = '';
    }
  }

  function toggleCredForm(providerId: string) {
    showCredForm[providerId] = !showCredForm[providerId];
    if (showCredForm[providerId] && !credForm[providerId]) {
      if (providerId === 'anthropic') {
        credForm[providerId] = { apiKey: '', baseUrl: '' };
      } else if (providerId === 'openai') {
        credForm[providerId] = { apiKey: '' };
      } else if (providerId === 'ollama') {
        credForm[providerId] = { baseUrl: 'http://localhost:11434' };
      }
    }
  }

  async function handleSaveCredentials(providerId: string) {
    savingCred = providerId;
    credMsg[providerId] = undefined as unknown as { text: string; ok: boolean };
    try {
      const form = credForm[providerId];
      const creds: { apiKey?: string; authToken?: string; baseUrl?: string } = {};
      if (providerId === 'anthropic') {
        creds.apiKey = form.apiKey;
        if (form.baseUrl) creds.baseUrl = form.baseUrl;
      } else if (providerId === 'openai') {
        creds.apiKey = form.apiKey;
      } else if (providerId === 'ollama') {
        creds.baseUrl = form.baseUrl;
      }
      await saveProviderCredentials(providerId, creds);
      credMsg[providerId] = { text: 'Credentials saved successfully', ok: true };
      // Reload config
      const data = await getConfig();
      config = data.config;
      // Clear form
      credForm[providerId] = {};
      showCredForm[providerId] = false;
    } catch (e: unknown) {
      credMsg[providerId] = { text: e instanceof Error ? e.message : 'Failed to save', ok: false };
    } finally {
      savingCred = '';
    }
  }

  async function loadModelInfo() {
    try {
      const data = await getModelInfo();
      primaryModel = data.primary;
      fallbackModel = data.fallback;
    } catch { /* non-critical */ }
  }

  onMount(async () => {
    try {
      const [configData, statusData] = await Promise.all([
        getConfig(),
        loadModelInfo(),
        getProviderStatus().then(s => { providerStatus = s; }).catch(() => {}),
        loadCapabilities(),
      ]);
      config = configData.config;
      loadRoutingState();
    } catch (e) {
      console.error('Failed to load config:', e);
    } finally {
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>Providers & Models - Admin - Kairo</title>
</svelte:head>

<div class="providers-page">
  <div class="page-header">
    <h1 class="page-title">Providers & Models</h1>
    <p class="page-desc">Manage AI provider connections, credentials, and model selection.</p>
  </div>

  {#if loading}
    <div class="loading"><span class="spinner"></span> Loading...</div>
  {:else}
    <div class="card current-model-card">
      <div class="current-model-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--cost)">
          <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
          <path d="M2 17l10 5 10-5"></path>
          <path d="M2 12l10 5 10-5"></path>
        </svg>
        <h3 class="section-title">Current Default Model</h3>
      </div>
      <div class="current-model">
        <code class="model-id">{getCurrentModel()}</code>
        {#if primaryModel?.capabilities}
          <span class="model-caps-inline">
            {formatTokens(primaryModel.capabilities.contextWindow)} ctx
            {#if primaryModel.capabilities.supportsVision}&middot; vision{/if}
            {#if primaryModel.capabilities.costPer1M}&middot; {formatCost(primaryModel.capabilities.costPer1M)}/1M{/if}
          </span>
        {/if}
      </div>
      <div class="current-model fallback-row">
        <span class="fallback-label">Fallback:</span>
        <code class="model-id">{getFallbackModel()}</code>
        {#if fallbackModel?.capabilities}
          <span class="model-caps-inline">
            {formatTokens(fallbackModel.capabilities.contextWindow)} ctx
          </span>
        {/if}
      </div>
      {#if saveMessage}
        <div class="save-message" class:save-success={!saveMessage.startsWith('Failed')} class:save-error={saveMessage.startsWith('Failed')}>
          {saveMessage}
        </div>
      {/if}
      <div class="current-model-actions">
        <button class="btn btn-sm" onclick={() => { showRouting = !showRouting; }}>
          {showRouting ? 'Close' : 'Routing'}
        </button>
        {#if routingEnabled}
          <span class="routing-badge">Smart routing active</span>
        {/if}
      </div>

      {#if showRouting}
        <div class="routing-panel">
          <div class="routing-section">
            <h4>Routing Mode</h4>
            <div class="routing-radios">
              <label class="routing-radio">
                <input type="radio" bind:group={routingEnabled} value={false} />
                <div>
                  <strong>Standard</strong>
                  <span class="routing-hint">Use primary model for all messages</span>
                </div>
              </label>
              <label class="routing-radio">
                <input type="radio" bind:group={routingEnabled} value={true} />
                <div>
                  <strong>Smart</strong>
                  <span class="routing-hint">Auto-pick Haiku / Sonnet / Opus per message</span>
                </div>
              </label>
            </div>
          </div>

          {#if routingEnabled}
            <div class="routing-section">
              <h4>Model Assignment</h4>
              <div class="routing-field">
                <label>Fast <span class="routing-hint">(greetings, simple questions)</span></label>
                <input type="text" bind:value={routingFastModel} />
              </div>
              <div class="routing-field">
                <label>Standard <span class="routing-hint">(from primary model)</span></label>
                <input type="text" value={getCurrentModel()} disabled />
              </div>
              <div class="routing-field">
                <label>Powerful <span class="routing-hint">(complex reasoning)</span></label>
                <input type="text" bind:value={routingPowerfulModel} />
              </div>
            </div>

            <div class="routing-section">
              <label class="routing-checkbox">
                <input type="checkbox" bind:checked={routingLlmClassifier} />
                <div>
                  <strong>LLM Classifier</strong>
                  <span class="routing-hint">Use Haiku to classify ambiguous messages (~200ms, more accurate)</span>
                </div>
              </label>
            </div>

            <div class="routing-section">
              <h4>Advanced</h4>
              <div class="routing-field">
                <label>Short message threshold <span class="routing-hint">(chars)</span></label>
                <input type="number" bind:value={routingShortThreshold} min="0" max="500" style="width: 80px" />
              </div>
              <div class="routing-field">
                <label>Opus patterns <span class="routing-hint">(regex, one per line)</span></label>
                <textarea bind:value={routingOpusPatterns} rows="2" placeholder="design.*architecture"></textarea>
              </div>
              <div class="routing-field">
                <label>Haiku patterns <span class="routing-hint">(regex, one per line)</span></label>
                <textarea bind:value={routingHaikuPatterns} rows="2" placeholder="translate.*to"></textarea>
              </div>
            </div>

            <p class="routing-tip">Tip: Users can override per-message with <code>@haiku</code>, <code>@sonnet</code>, or <code>@opus</code> prefix.</p>
          {/if}

          <div class="routing-actions">
            <button class="btn btn-sm btn-primary" onclick={saveRouting} disabled={routingSaving}>
              {routingSaving ? 'Saving...' : 'Save Routing'}
            </button>
            {#if routingMsg}
              <span class="routing-msg" class:routing-error={routingMsg.includes('fail')}>{routingMsg}</span>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    <div class="provider-list">
      {#each providers as provider}
        <div class="card provider-card">
          <div class="provider-header">
            <div class="provider-info">
              <div class="provider-name-row">
                <span class="provider-dot" style="background: {provider.color}"></span>
                <h3 class="provider-name">{provider.name}</h3>
              </div>
              <p class="provider-desc">{provider.description}</p>
            </div>
            <Badge variant={getBadgeVariant(provider.id)}>
              {getBadgeLabel(provider.id)}
            </Badge>
          </div>

          {#if isConfigured(provider.id)}
            <div class="provider-details">
              {#if provider.id === 'anthropic'}
                <div class="detail-row">
                  <span class="detail-label">Auth:</span>
                  <span class="detail-value">API Key</span>
                </div>
              {/if}
              {#if provider.id === 'openai'}
                <div class="detail-row">
                  <span class="detail-label">API Key:</span>
                  <span class="detail-value">****</span>
                </div>
              {/if}
              {#if provider.id === 'ollama'}
                {@const pc = getProviderConfig('ollama')}
                <div class="detail-row">
                  <span class="detail-label">Base URL:</span>
                  <span class="detail-value">{pc?.baseUrl || 'N/A'}</span>
                </div>
              {/if}
            </div>
          {/if}

          <div class="provider-actions">
            <button
              class="btn btn-sm"
              aria-label="Test connection to {provider.name}"
              onclick={() => handleTest(provider.id)}
              disabled={testingProvider[provider.id]}
            >
              {#if testingProvider[provider.id]}
                <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span>
                Testing...
              {:else}
                Test Connection
              {/if}
            </button>
            <button
              class="btn btn-sm"
              aria-label="{showCredForm[provider.id] ? 'Cancel configuring' : 'Configure'} {provider.name}"
              onclick={() => toggleCredForm(provider.id)}
            >
              {showCredForm[provider.id] ? 'Cancel' : 'Configure'}
            </button>
          </div>

          <!-- Credential form -->
          {#if showCredForm[provider.id]}
            <div class="cred-form">
              {#if provider.id === 'anthropic'}
                <div class="cred-field">
                  <label class="cred-label" for="anthropic-apikey">API Key</label>
                  <div class="cred-input-row">
                    <input id="anthropic-apikey" type={showPassword['anthropic-apikey'] ? 'text' : 'password'} class="cred-input" bind:value={credForm[provider.id].apiKey} placeholder="your-anthropic-api-key" />
                    <button class="btn btn-xs" type="button" onclick={() => showPassword['anthropic-apikey'] = !showPassword['anthropic-apikey']}>
                      {showPassword['anthropic-apikey'] ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </div>
                <div class="cred-field">
                  <label class="cred-label" for="anthropic-baseurl">Base URL (optional)</label>
                  <input id="anthropic-baseurl" type="text" class="cred-input" bind:value={credForm[provider.id].baseUrl} placeholder="https://api.anthropic.com" />
                </div>
              {:else if provider.id === 'openai'}
                <div class="cred-field">
                  <label class="cred-label" for="openai-apikey">API Key</label>
                  <div class="cred-input-row">
                    <input id="openai-apikey" type={showPassword['openai-apikey'] ? 'text' : 'password'} class="cred-input" bind:value={credForm[provider.id].apiKey} placeholder="sk-..." />
                    <button class="btn btn-xs" type="button" onclick={() => showPassword['openai-apikey'] = !showPassword['openai-apikey']}>
                      {showPassword['openai-apikey'] ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
              {:else if provider.id === 'ollama'}
                <div class="cred-field">
                  <label class="cred-label" for="ollama-baseurl">Base URL</label>
                  <input id="ollama-baseurl" type="text" class="cred-input" bind:value={credForm[provider.id].baseUrl} placeholder="http://localhost:11434" />
                </div>
              {/if}
              <div class="cred-actions">
                <button
                  class="btn btn-sm btn-primary"
                  aria-label="Save {provider.name} credentials"
                  onclick={() => handleSaveCredentials(provider.id)}
                  disabled={savingCred === provider.id}
                >
                  {savingCred === provider.id ? 'Saving...' : 'Save'}
                </button>
              </div>
              {#if credMsg[provider.id]}
                <div class="cred-msg" class:cred-msg-ok={credMsg[provider.id].ok} class:cred-msg-err={!credMsg[provider.id].ok}>
                  {credMsg[provider.id].text}
                </div>
              {/if}
            </div>
          {/if}

          <!-- Inline test results -->
          {#if testResults[provider.id]}
            {@const result = testResults[provider.id]}
            <div class="test-result-inline" class:success={result.success} class:failure={!result.success}>
              <h4 class="test-result-title">Test Result</h4>
              {#if result.success}
                <Badge variant="green">Connected</Badge>
                {#if result.authType}
                  <span class="test-detail">Auth: {result.authType}</span>
                {/if}
                {#if result.models && result.models.length > 0}
                  <div class="models-list">
                    <h4>Available Models ({result.models.length})</h4>
                    <div class="models-select-grid">
                      {#each result.models as model}
                        {@const isDefault = getCurrentModel().endsWith(model.id)}
                        {@const isFallback = getFallbackModel().endsWith(model.id)}
                        <div class="model-row" class:active-model={isDefault} class:fallback-model={isFallback && !isDefault}>
                          <div class="model-row-info">
                            <code class="model-row-name">{model.name || model.id}</code>
                            {#if model.capabilities}
                              <span class="model-row-caps">
                                {formatTokens(model.capabilities.contextWindow || 0)} ctx
                                {#if model.capabilities.supportsVision}<span class="cap-icon" title="Vision">&#x1F441;</span>{/if}
                                {#if model.capabilities.supportsToolCalling}<span class="cap-icon" title="Tools">&#x1F527;</span>{/if}
                                {#if model.capabilities.costPer1M}&middot; {formatCost(model.capabilities.costPer1M)}/1M{/if}
                              </span>
                            {/if}
                          </div>
                          <div class="model-row-actions">
                            {#if isDefault}
                              <Badge variant="green">Default</Badge>
                            {/if}
                            {#if isFallback}
                              <Badge variant="yellow">Fallback</Badge>
                            {/if}
                            {#if !isDefault}
                              <button
                                class="btn btn-xs"
                                aria-label="Set {model.name || model.id} as default model"
                                onclick={() => {
                                  if (hasKnownCaps(model.capabilities)) {
                                    handleSetDefault(provider.id, model.id);
                                  } else {
                                    startEditCaps(provider.id, model.id, model.capabilities || {}, 'default');
                                  }
                                }}
                                disabled={savingModel === model.id}
                              >
                                {savingModel === model.id ? 'Saving...' : 'Set as Default'}
                              </button>
                            {/if}
                            {#if !isFallback}
                              <button
                                class="btn btn-xs"
                                aria-label="Set {model.name || model.id} as fallback model"
                                onclick={() => {
                                  if (hasKnownCaps(model.capabilities)) {
                                    handleSetFallback(provider.id, model.id);
                                  } else {
                                    startEditCaps(provider.id, model.id, model.capabilities || {}, 'fallback');
                                  }
                                }}
                                disabled={savingModel === model.id}
                              >
                                {savingModel === model.id ? 'Saving...' : 'Set as Fallback'}
                              </button>
                            {/if}
                            <button
                              class="btn btn-xs"
                              aria-label="Edit capabilities for {model.name || model.id}"
                              onclick={() => startEditCaps(provider.id, model.id, model.capabilities || {})}
                            >Edit</button>
                          </div>
                          {#if editingCaps === model.id}
                            <div class="caps-editor" class:caps-required={!!pendingModelAction}>
                              {#if pendingModelAction}
                                <div class="caps-warning">This model's capabilities are unknown. Configure them before activating.</div>
                              {/if}
                              <div class="caps-row">
                                <label class="caps-label">Context</label>
                                <input type="number" class="caps-input" bind:value={capsForm.contextWindow} />
                              </div>
                              <div class="caps-row">
                                <label class="caps-label">Max Output</label>
                                <input type="number" class="caps-input" bind:value={capsForm.maxOutputTokens} />
                              </div>
                              <div class="caps-row">
                                <label class="caps-label">Timeout (ms)</label>
                                <input type="number" class="caps-input" bind:value={capsForm.timeoutMs} />
                              </div>
                              <div class="caps-row">
                                <label class="caps-check"><input type="checkbox" bind:checked={capsForm.supportsVision} /> Vision</label>
                                <label class="caps-check"><input type="checkbox" bind:checked={capsForm.supportsToolCalling} /> Tools</label>
                              </div>
                              <div class="caps-row">
                                <button class="btn btn-xs btn-primary" aria-label="Save model capabilities" onclick={handleSaveCaps} disabled={savingCaps}>
                                  {savingCaps ? 'Saving...' : pendingModelAction ? `Save & Set as ${pendingModelAction.type === 'default' ? 'Default' : 'Fallback'}` : 'Save'}
                                </button>
                                <button class="btn btn-xs" aria-label="Cancel editing capabilities" onclick={() => { editingCaps = null; }}>Cancel</button>
                                {#if capsMsg}<span class="caps-msg">{capsMsg}</span>{/if}
                              </div>
                            </div>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}
              {:else}
                <Badge variant="red">Failed</Badge>
                <p class="test-error">{result.error}</p>
              {/if}
            </div>
          {/if}

        </div>
      {/each}

      <!-- Kairo Premium Provider -->
      {#if providerStatus.kairoPremium}
        <div class="card provider-card premium-card">
          <div class="provider-header">
            <div class="provider-info">
              <div class="provider-name-row">
                <span class="provider-dot" style="background: var(--cost)"></span>
                <h3 class="provider-name">Kairo Premium</h3>
              </div>
              <p class="provider-desc">Use your Claude Pro/Max subscription — no per-token API fees</p>
            </div>
            {#if !providerStatus.kairoPremium.available}
              <Badge variant="default">Not installed</Badge>
            {:else if !providerStatus.kairoPremium.enabled}
              <Badge variant="default">Disabled</Badge>
            {:else if providerStatus.kairoPremium.configured}
              <Badge variant={testResults['kairo-premium']?.success ? 'green' : 'yellow'}>
                {testResults['kairo-premium']?.success ? 'Connected' : 'Configured'}
              </Badge>
            {:else}
              <Badge variant="default">Not configured</Badge>
            {/if}
          </div>

          {#if !providerStatus.kairoPremium.available}
            <div class="premium-notice">
              <p>Install the enterprise package to enable premium authentication:</p>
              <code class="install-cmd">echo "@bsigma-ai:registry=https://npm.pkg.github.com" >> .npmrc && pnpm install @bsigma-ai/kairo-enterprise</code>
              <p style="margin-top: 6px; font-size: 11px;">Requires a GitHub PAT with <code>read:packages</code> scope. Contact your administrator for access.</p>
            </div>
          {:else}
            <!-- Enable/Disable toggle -->
            <div class="provider-toggle">
              <label class="toggle-label">
                <input
                  type="checkbox"
                  checked={providerStatus.kairoPremium.enabled}
                  onchange={async (e) => {
                    const checkbox = e.target as HTMLInputElement;
                    const enabled = checkbox.checked;

                    if (!enabled) {
                      const primary = getCurrentModel();
                      const fallback = getFallbackModel();
                      const isDefault = primary.startsWith('kairo-premium/');
                      const isFallback = fallback.startsWith('kairo-premium/');

                      if (isDefault || isFallback) {
                        checkbox.checked = true;
                        const which = isDefault && isFallback ? 'default and fallback model'
                          : isDefault ? 'default model' : 'fallback model';
                        premiumToggleWarning = `Cannot disable — Kairo Premium is your ${which}. Change it first.`;
                        return;
                      }
                    }

                    premiumToggleWarning = '';
                    await updateConfig('providers.kairoPremium.enabled', enabled);
                    providerStatus = { ...providerStatus, kairoPremium: { ...providerStatus.kairoPremium, enabled } };
                  }}
                />
                <span>{providerStatus.kairoPremium.enabled ? 'Enabled' : 'Disabled'}</span>
              </label>
              {#if premiumToggleWarning}
                <div class="toggle-warning">{premiumToggleWarning}</div>
              {/if}
            </div>

            <!-- Mode selector -->
            <div class="provider-details">
              <div class="detail-row">
                <span class="detail-label">Mode:</span>
                <select
                  class="mode-select"
                  value={providerStatus.kairoPremium.mode || 'oauth'}
                  onchange={async (e) => {
                    const mode = (e.target as HTMLSelectElement).value;
                    await updateConfig('providers.kairoPremium.mode', mode);
                    providerStatus = { ...providerStatus, kairoPremium: { ...providerStatus.kairoPremium, mode } };
                  }}
                >
                  <option value="oauth">OAuth Token (Anthropic subscription)</option>
                  <option value="sdk">Claude CLI/SDK (local CLI)</option>
                </select>
              </div>

              {#if providerStatus.kairoPremium.mode === 'sdk'}
                <p class="mode-hint">Uses the Claude CLI installed on the server. Auth token optional for LLM calls, but needed to list available models.</p>
              {:else}
                <p class="mode-hint">Uses an Anthropic OAuth token for direct API access via your Claude Pro/Max subscription.</p>
              {/if}

              <!-- Credentials summary -->
              <div class="detail-row">
                <span class="detail-label">Auth Token:</span>
                <span class="detail-value">{providerStatus.kairoPremium.hasAuthToken ? '****' : 'Not set'}{providerStatus.kairoPremium.mode === 'sdk' && !providerStatus.kairoPremium.hasAuthToken ? ' (optional)' : ''}</span>
              </div>
            </div>

            <div class="provider-actions">
              <button
                class="btn btn-sm"
                onclick={() => handleTest('kairo-premium')}
                disabled={testingProvider['kairo-premium']}
              >
                {#if testingProvider['kairo-premium']}
                  <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span>
                  Testing...
                {:else}
                  Test Connection
                {/if}
              </button>
              <button
                class="btn btn-sm"
                onclick={() => {
                  showCredForm['kairo-premium'] = !showCredForm['kairo-premium'];
                  if (showCredForm['kairo-premium'] && !credForm['kairo-premium']) {
                    credForm['kairo-premium'] = { authToken: '' };
                  }
                }}
              >
                {showCredForm['kairo-premium'] ? 'Cancel' : 'Configure'}
              </button>
              {#if providerStatus.kairoPremium.hasAuthToken}
                <button
                  class="btn btn-sm"
                  onclick={async () => {
                    savingCred = 'kairo-premium-clear';
                    try {
                      await saveProviderCredentials('kairo-premium', { authToken: '' });
                      credMsg['kairo-premium'] = { text: 'Credentials cleared', ok: true };
                      providerStatus = await getProviderStatus();
                    } catch (e) {
                      credMsg['kairo-premium'] = { text: e instanceof Error ? e.message : 'Failed', ok: false };
                    } finally {
                      savingCred = '';
                    }
                  }}
                  disabled={savingCred === 'kairo-premium-clear'}
                >
                  {savingCred === 'kairo-premium-clear' ? 'Clearing...' : 'Clear Token'}
                </button>
              {/if}
            </div>

            {#if showCredForm['kairo-premium']}
              <div class="cred-form">
                <div class="cred-field">
                    <label class="cred-label" for="kairo-token">Auth Token (Anthropic OAuth){providerStatus.kairoPremium.mode === 'sdk' ? ' — optional, for model listing' : ''}</label>
                    <div class="cred-input-row">
                      <input id="kairo-token" type={showPassword['kairo-token'] ? 'text' : 'password'} class="cred-input" bind:value={credForm['kairo-premium'].authToken} placeholder="your-oauth-token" />
                      <button class="btn btn-xs" type="button" onclick={() => showPassword['kairo-token'] = !showPassword['kairo-token']}>
                        {showPassword['kairo-token'] ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </div>
                <div class="cred-actions">
                  <button
                    class="btn btn-sm btn-primary"
                    onclick={async () => {
                      savingCred = 'kairo-premium';
                      try {
                        await saveProviderCredentials('kairo-premium', credForm['kairo-premium']);
                        credMsg['kairo-premium'] = { text: 'Saved', ok: true };
                        showCredForm['kairo-premium'] = false;
                        providerStatus = await getProviderStatus();
                      } catch (e) {
                        credMsg['kairo-premium'] = { text: e instanceof Error ? e.message : 'Failed', ok: false };
                      } finally {
                        savingCred = '';
                      }
                    }}
                    disabled={savingCred === 'kairo-premium'}
                  >
                    {savingCred === 'kairo-premium' ? 'Saving...' : 'Save'}
                  </button>
                </div>
                {#if credMsg['kairo-premium']}
                  <div class="cred-msg" class:cred-msg-ok={credMsg['kairo-premium'].ok} class:cred-msg-err={!credMsg['kairo-premium'].ok}>
                    {credMsg['kairo-premium'].text}
                  </div>
                {/if}
              </div>
            {/if}

            {#if testResults['kairo-premium']}
              {@const result = testResults['kairo-premium']}
              <div class="test-result-inline" class:success={result.success} class:failure={!result.success}>
                <h4 class="test-result-title">Test Result</h4>
                {#if result.success}
                  <Badge variant="green">Connected</Badge>
                  {#if result.model}<span class="test-detail">Model: {result.model}</span>{/if}
                  {#if result.models && result.models.length > 0}
                    <div class="models-list">
                      <h4>Available Models ({result.models.length})</h4>
                      <div class="models-select-grid">
                        {#each result.models as model}
                          {@const fullRef = `kairo-premium/${model.id}`}
                          {@const isDefault = getCurrentModel() === fullRef}
                          {@const isFallback = getFallbackModel() === fullRef}
                          <div class="model-row" class:active-model={isDefault} class:fallback-model={isFallback && !isDefault}>
                            <div class="model-row-info">
                              <code class="model-row-name">{model.name || model.id}</code>
                            </div>
                            <div class="model-row-actions">
                              {#if isDefault}<Badge variant="green">Default</Badge>{/if}
                              {#if isFallback}<Badge variant="yellow">Fallback</Badge>{/if}
                              {#if !isDefault}
                                <button class="btn btn-xs" onclick={() => handleSetDefault('kairo-premium', model.id)} disabled={savingModel === model.id}>
                                  Set Default
                                </button>
                              {/if}
                              {#if !isFallback}
                                <button class="btn btn-xs" onclick={() => handleSetFallback('kairo-premium', model.id)} disabled={savingModel === model.id}>
                                  Set Fallback
                                </button>
                              {/if}
                            </div>
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                {:else}
                  <Badge variant="red">Failed</Badge>
                  <span class="test-detail">{result.error}</span>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <!-- ── Model Capabilities Section ────────────────────────── -->
  {#if !loading}
    <div class="card model-caps-card">
      <div class="model-caps-header">
        <div>
          <h3 class="mc-title">Model Capabilities</h3>
          <p class="section-desc">Auto-fetched from provider APIs. Edit to override.</p>
        </div>
        <button
          class="btn btn-sm"
          onclick={handleRefreshCaps}
          disabled={refreshingCaps}
        >
          {refreshingCaps ? 'Refreshing...' : 'Refresh from APIs'}
        </button>
      </div>
      {#if refreshMsg}
        <p class="mc-refresh-msg" class:mc-refresh-error={refreshMsg.startsWith('Refresh failed')}>{refreshMsg}</p>
      {/if}

      {#if allCapabilities.length > 0}
        <div class="mc-filter">
          <input
            type="text"
            class="mc-filter-input"
            placeholder="Filter models..."
            bind:value={capsFilter}
          />
        </div>

        <div class="mc-table">
          <div class="mc-row mc-header-row">
            <span class="mc-col-name">Model</span>
            <span class="mc-col-provider">Provider</span>
            <span class="mc-col-ctx">Context</span>
            <span class="mc-col-cap mc-col-vision">Vision</span>
            <span class="mc-col-cap mc-col-think">Think</span>
            <span class="mc-col-cap mc-col-tools">Tools</span>
            <span class="mc-col-cost">Cost/1M</span>
            <span class="mc-col-source">Source</span>
            <span class="mc-col-actions">Actions</span>
          </div>

          {#each filteredCapabilities() as entry}
            {@const fullRef = (entry.provider && entry.provider !== 'unknown' ? entry.provider + '/' : '') + entry.id}
            {@const currentModel = getCurrentModel()}
            {@const fallbackModelRef = getFallbackModel()}
            {@const bareCurrentModel = currentModel.includes('/') ? currentModel.split('/').slice(1).join('/') : currentModel}
            {@const bareFallbackModel = fallbackModelRef.includes('/') ? fallbackModelRef.split('/').slice(1).join('/') : fallbackModelRef}
            {@const isDefault = currentModel === fullRef || bareCurrentModel === entry.id}
            {@const isFallback = fallbackModelRef === fullRef || bareFallbackModel === entry.id}

            <div class="mc-row" class:active-model={isDefault} class:fallback-model={isFallback && !isDefault}>
              <span class="mc-col-name">
                <code class="model-id">{entry.displayName || entry.id}</code>
                {#if isDefault}<Badge variant="green">Default</Badge>{/if}
                {#if isFallback}<Badge variant="yellow">Fallback</Badge>{/if}
              </span>
              <span class="mc-col-provider">{entry.provider || '—'}</span>
              <span class="mc-col-ctx">{entry.contextWindow ? formatTokens(entry.contextWindow) : '—'}</span>
              <span class="mc-col-cap mc-col-vision">{entry.supportsVision ? '✓' : '—'}</span>
              <span class="mc-col-cap mc-col-think">{entry.supportsThinking ? '✓' : '—'}</span>
              <span class="mc-col-cap mc-col-tools">{entry.supportsToolCalling ? '✓' : '—'}</span>
              <span class="mc-col-cost">{entry.costPer1M ? `$${entry.costPer1M.input}/$${entry.costPer1M.output}` : '—'}</span>
              <span class="mc-col-source">
                {#if entry.source === 'manual'}
                  <Badge variant="yellow">manual</Badge>
                {:else}
                  <Badge variant="default">auto</Badge>
                {/if}
              </span>
              <span class="mc-col-actions">
                {#if !isDefault}
                  <button class="btn btn-xs" onclick={() => handleSetDefault(entry.provider && entry.provider !== 'unknown' ? entry.provider : 'anthropic', entry.id)} disabled={savingModel === entry.id}>Default</button>
                {/if}
                {#if !isFallback}
                  <button class="btn btn-xs" onclick={() => handleSetFallback(entry.provider && entry.provider !== 'unknown' ? entry.provider : 'anthropic', entry.id)} disabled={savingModel === entry.id}>Fallback</button>
                {/if}
                <button class="btn btn-xs" onclick={() => startCapEdit(entry)}>Edit</button>
              </span>
            </div>

            {#if editingCapId === entry.id}
              <div class="mc-edit-row">
                <div class="mc-edit-grid">
                  <label>Context Window <input type="number" bind:value={capEditForm.contextWindow} /></label>
                  <label>Max Output <input type="number" bind:value={capEditForm.maxOutputTokens} /></label>
                  <label>Timeout (ms) <input type="number" bind:value={capEditForm.timeoutMs} /></label>
                  <label>Cost Input/1M <input type="number" step="0.01" bind:value={capEditForm.costInputPerM} placeholder="e.g. 3" /></label>
                  <label>Cost Output/1M <input type="number" step="0.01" bind:value={capEditForm.costOutputPerM} placeholder="e.g. 15" /></label>
                </div>
                <div class="mc-edit-checks">
                  <label><input type="checkbox" bind:checked={capEditForm.supportsVision} /> Vision</label>
                  <label><input type="checkbox" bind:checked={capEditForm.supportsThinking} /> Thinking</label>
                  <label><input type="checkbox" bind:checked={capEditForm.supportsToolCalling} /> Tools</label>
                </div>
                <div class="mc-edit-actions">
                  <button class="btn btn-sm btn-primary" onclick={saveCapEdit} disabled={savingCapEdit}>
                    {savingCapEdit ? 'Saving...' : 'Save'}
                  </button>
                  <button class="btn btn-sm" onclick={() => { editingCapId = null; }}>Cancel</button>
                  {#if capEditMsg}<span class="mc-edit-msg">{capEditMsg}</span>{/if}
                </div>
              </div>
            {/if}
          {/each}
        </div>
      {:else if loadingCaps}
        <p class="mc-empty">Loading model capabilities...</p>
      {:else}
        <p class="mc-empty">No model capabilities yet. Click "Refresh from APIs" or test a provider connection.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .providers-page {
    max-width: 800px;
  }
  .page-header {
    margin-bottom: 24px;
  }
  .page-title {
    font-size: 24px;
    font-weight: 700;
    margin-bottom: 4px;
    letter-spacing: -0.3px;
  }
  .page-desc {
    color: var(--text-muted);
    font-size: 14px;
  }
  .loading {
    color: var(--text-muted);
    padding: 40px 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .current-model-card {
    padding: 18px 22px;
    margin-bottom: 24px;
  }
  .current-model-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .section-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .current-model {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fallback-row {
    margin-top: 8px;
  }
  .fallback-label {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 500;
  }
  .model-id {
    font-size: 15px;
    font-family: var(--font-mono);
    color: var(--text-primary);
    background: var(--bg-void);
    padding: 4px 12px;
    border-radius: var(--radius);
    border: 1px solid var(--border-subtle);
  }
  .save-message {
    margin-top: 8px;
    font-size: 13px;
    padding: 6px 10px;
    border-radius: var(--radius);
  }
  .save-success {
    color: var(--green);
    background: var(--green-subtle);
  }
  .save-error {
    color: var(--red);
    background: var(--red-subtle);
  }
  .provider-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin-bottom: 24px;
  }
  .provider-card {
    padding: 20px 22px;
    transition: border-color var(--duration) var(--ease);
  }
  .premium-card {
    border-left: 3px solid var(--cost);
  }
  .premium-notice {
    font-size: 12px;
    color: var(--text-muted);
    padding: 8px 0;
  }
  .install-cmd {
    display: block;
    background: var(--bg-secondary, #1a1a2e);
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 11px;
    margin-top: 6px;
    word-break: break-all;
    user-select: all;
  }
  .provider-toggle {
    padding: 8px 0;
  }
  .toggle-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
  }
  .toggle-label input[type="checkbox"] {
    cursor: pointer;
  }
  .mode-select {
    background: var(--bg-secondary, #1a1a2e);
    color: var(--text, #e0e0e0);
    border: 1px solid var(--border, #333);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 13px;
    cursor: pointer;
  }
  .mode-hint {
    font-size: 12px;
    color: var(--text-muted, #888);
    margin: 4px 0 8px;
    font-style: italic;
  }
  .toggle-warning {
    margin-top: 6px;
    padding: 6px 10px;
    font-size: 12px;
    color: var(--warning, #f59e0b);
    background: rgba(245, 158, 11, 0.1);
    border-radius: 4px;
    border-left: 3px solid var(--warning, #f59e0b);
  }
  .provider-card:hover {
    border-color: var(--border);
  }
  .provider-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 12px;
  }
  .provider-name-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .provider-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .provider-name {
    font-size: 16px;
    font-weight: 600;
  }
  .provider-desc {
    font-size: 13px;
    color: var(--text-secondary);
  }
  .provider-details {
    margin-bottom: 12px;
    padding: 10px 14px;
    background: var(--bg-void);
    border-radius: var(--radius);
    border: 1px solid var(--border-subtle);
  }
  .detail-row {
    display: flex;
    gap: 8px;
    font-size: 13px;
  }
  .detail-label {
    color: var(--text-muted);
    min-width: 80px;
  }
  .detail-value {
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }
  .provider-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  /* Credential form styles */
  .cred-form {
    margin-top: 14px;
    padding: 16px;
    background: var(--bg-void);
    border-radius: var(--radius);
    border: 1px solid var(--border-subtle);
  }
  .cred-field {
    margin-bottom: 12px;
  }
  .cred-label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
    margin-bottom: 4px;
  }
  .cred-input-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .cred-input-row .cred-input {
    flex: 1;
  }
  .cred-input {
    width: 100%;
    padding: 7px 10px;
    font-size: 13px;
    font-family: var(--font-mono);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
    outline: none;
    transition: border-color var(--duration) var(--ease);
    box-sizing: border-box;
  }
  .cred-input:focus {
    border-color: var(--accent);
  }
  .cred-radio-group {
    display: flex;
    gap: 16px;
  }
  .cred-radio {
    font-size: 13px;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }
  .cred-actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }
  .cred-msg {
    margin-top: 8px;
    font-size: 12px;
    padding: 5px 10px;
    border-radius: var(--radius);
  }
  .cred-msg-ok {
    color: var(--green);
    background: var(--green-subtle);
  }
  .cred-msg-err {
    color: var(--red);
    background: var(--red-subtle);
  }
  /* Inline test result styles */
  .test-result-inline {
    margin-top: 16px;
    padding: 16px;
    background: var(--bg-void);
    border-radius: var(--radius);
    border: 1px solid var(--border-subtle);
  }
  .test-result-title {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 12px;
  }
  .test-detail {
    font-size: 13px;
    color: var(--text-secondary);
    margin-left: 8px;
  }
  .test-error {
    color: var(--red);
    font-size: 13px;
    margin-top: 8px;
  }
  .models-list {
    margin-top: 16px;
  }
  .models-list h4 {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 8px;
  }
  .models-select-grid {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .model-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    padding: 8px 12px;
    background: var(--bg-raised);
    border-radius: var(--radius);
    font-size: 13px;
    transition: background var(--duration) var(--ease);
  }
  .model-row:hover {
    background: var(--bg-overlay);
  }
  .model-row.active-model {
    background: var(--green-subtle);
    border: 1px solid rgba(52, 211, 153, 0.15);
  }
  .model-row.fallback-model {
    background: var(--yellow-subtle, rgba(251, 191, 36, 0.08));
    border: 1px solid rgba(251, 191, 36, 0.15);
  }
  .model-row-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .model-row-name {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-secondary);
  }
  .model-row-caps {
    font-size: 11px;
    color: var(--text-muted);
  }
  .cap-icon {
    font-size: 12px;
    margin-left: 2px;
  }
  .model-caps-inline {
    font-size: 12px;
    color: var(--text-muted);
    margin-left: 8px;
  }
  .model-row-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .caps-editor {
    width: 100%;
    margin-top: 8px;
    padding: 10px 12px;
    background: var(--bg-void);
    border-radius: var(--radius);
    border: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .caps-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .caps-label {
    font-size: 11px;
    color: var(--text-muted);
    min-width: 70px;
  }
  .caps-input {
    width: 120px;
    padding: 3px 6px;
    font-size: 12px;
    font-family: var(--font-mono);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
  }
  .caps-check {
    font-size: 11px;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }
  .caps-msg {
    font-size: 11px;
    color: var(--green);
  }
  .caps-required {
    border-color: var(--yellow, #fbbf24);
  }
  .caps-warning {
    font-size: 12px;
    color: var(--yellow, #fbbf24);
    padding: 6px 8px;
    background: rgba(251, 191, 36, 0.08);
    border-radius: var(--radius);
    margin-bottom: 4px;
  }

  @media (max-width: 768px) {
    .page-title { font-size: 20px; }
    .page-desc { font-size: 13px; }
    .provider-header {
      flex-direction: column;
      gap: 8px;
    }
    .cred-input-row {
      flex-direction: column;
      align-items: stretch;
    }
    .cred-input-row .cred-input { flex: none; }
    .model-row {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }
    .model-row-actions {
      flex-wrap: wrap;
    }
    .caps-row { flex-wrap: wrap; }
    .caps-input { width: 100%; }
    .current-model {
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
    }
    .model-caps-inline { margin-left: 0; }
    .model-id { font-size: 13px; word-break: break-all; }
  }

  /* ── Routing panel ── */
  .current-model-actions { margin-top: 12px; display: flex; align-items: center; gap: 10px; }
  .routing-badge { font-size: 0.75rem; color: var(--green, #4ade80); background: rgba(74, 222, 128, 0.1); padding: 2px 8px; border-radius: 4px; }
  .routing-panel { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
  .routing-section { margin-bottom: 16px; }
  .routing-section h4 { font-size: 0.85rem; margin: 0 0 8px 0; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .routing-radios { display: flex; flex-direction: column; gap: 6px; }
  .routing-radio, .routing-checkbox { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 6px; border-radius: 4px; }
  .routing-radio:hover, .routing-checkbox:hover { background: var(--bg-hover, rgba(255,255,255,0.03)); }
  .routing-radio input, .routing-checkbox input { margin-top: 3px; }
  .routing-radio strong, .routing-checkbox strong { display: block; font-size: 0.9rem; }
  .routing-hint { color: var(--text-muted); font-size: 0.8rem; }
  .routing-field { margin-bottom: 10px; }
  .routing-field label { display: block; margin-bottom: 3px; font-size: 0.85rem; }
  .routing-field input, .routing-field textarea { width: 100%; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-input, #0d0d1a); color: var(--text); font-size: 0.85rem; }
  .routing-field input:disabled { opacity: 0.5; }
  .routing-field textarea { resize: vertical; font-family: monospace; font-size: 0.8rem; }
  .routing-tip { color: var(--text-muted); font-size: 0.8rem; margin: 8px 0; }
  .routing-tip code { background: rgba(255,255,255,0.06); padding: 1px 4px; border-radius: 3px; font-size: 0.8em; }
  .routing-actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
  .btn-primary { background: var(--accent, #6366f1) !important; color: white !important; }
  .routing-msg { font-size: 0.85rem; color: var(--green, #4ade80); }
  .routing-msg.routing-error { color: var(--error, #f87171); }

  /* ── Model Capabilities Section ── */
  .model-caps-card { padding: 20px 24px; margin-top: 24px; }
  .model-caps-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
  .mc-title { font-size: 16px; font-weight: 600; margin-bottom: 2px; }
  .section-desc { font-size: 12px; color: var(--text-muted); }
  .mc-filter { margin-bottom: 12px; }
  .mc-filter-input { width: 100%; padding: 6px 10px; font-size: 13px; background: var(--bg-secondary, #1a1a2e); border: 1px solid var(--border, #333); border-radius: 4px; color: var(--text); }
  .mc-table { font-size: 12px; overflow-x: auto; }
  .mc-row { display: grid; grid-template-columns: 2fr 1fr 0.8fr 0.5fr 0.5fr 0.5fr 1fr 0.7fr 1.5fr; align-items: center; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--border-subtle, #222); }
  .mc-header-row { font-weight: 600; color: var(--text-muted); border-bottom: 2px solid var(--border, #333); padding-bottom: 8px; margin-bottom: 4px; }
  .mc-row:hover:not(.mc-header-row) { background: var(--bg-hover, #1a1a2e); }
  .mc-col-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  .mc-col-provider { color: var(--text-muted); }
  .mc-col-ctx { text-align: center; }
  .mc-col-cap { text-align: center; }
  .mc-col-cost { text-align: center; font-size: 11px; color: var(--text-muted); }
  .mc-col-source { text-align: center; }
  .mc-col-actions { display: flex; gap: 4px; flex-wrap: wrap; }
  .model-id { font-size: 12px; }
  .mc-empty { color: var(--text-muted); font-size: 13px; padding: 20px 0; text-align: center; }
  .mc-edit-row { padding: 12px 8px; background: var(--bg-secondary, #1a1a2e); border-radius: 6px; margin: 4px 0 8px; }
  .mc-edit-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin-bottom: 8px; }
  .mc-edit-grid label { font-size: 11px; color: var(--text-muted); display: flex; flex-direction: column; gap: 2px; }
  .mc-edit-grid input { padding: 4px 6px; font-size: 12px; background: var(--bg, #0d0d1a); border: 1px solid var(--border, #333); border-radius: 3px; color: var(--text); }
  .mc-edit-checks { display: flex; gap: 12px; margin-bottom: 8px; font-size: 12px; }
  .mc-edit-checks label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .mc-edit-actions { display: flex; align-items: center; gap: 8px; }
  .mc-edit-msg { font-size: 12px; color: var(--green, #4ade80); }
  .mc-refresh-msg { font-size: 12px; color: var(--green, #4ade80); margin-bottom: 12px; }
  .mc-refresh-error { color: var(--error, #f87171); }

  @media (max-width: 900px) {
    .model-caps-header { flex-direction: column; gap: 8px; }
    .mc-header-row { display: none; }
    .mc-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 8px;
      border: 1px solid var(--border-subtle, #222);
      border-radius: 6px;
      margin-bottom: 8px;
    }
    .mc-col-name { white-space: normal; flex-wrap: wrap; }
    .mc-col-provider::before { content: 'Provider: '; color: var(--text-muted); font-size: 11px; }
    .mc-col-ctx::before { content: 'Context: '; color: var(--text-muted); font-size: 11px; }
    .mc-col-cap { text-align: left; }
    .mc-col-vision::before { content: 'Vision: '; color: var(--text-muted); font-size: 11px; }
    .mc-col-think::before { content: 'Think: '; color: var(--text-muted); font-size: 11px; }
    .mc-col-tools::before { content: 'Tools: '; color: var(--text-muted); font-size: 11px; }
    .mc-col-cost { text-align: left; }
    .mc-col-cost::before { content: 'Cost: '; color: var(--text-muted); font-size: 11px; }
    .mc-col-source { text-align: left; }
    .mc-col-actions { justify-content: flex-start; }
    .mc-edit-grid { grid-template-columns: 1fr 1fr; }
  }

  @media (max-width: 480px) {
    .mc-edit-grid { grid-template-columns: 1fr; }
    .mc-edit-checks { flex-direction: column; gap: 6px; }
  }
</style>
