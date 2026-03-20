<script lang="ts">
  import { onMount } from 'svelte';
  import { getConfig, testProvider, updateConfig, saveProviderCredentials, getModelInfo, saveModelCapabilities } from '$lib/api';
  import type { ModelInfo } from '$lib/api';
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
  let saveMessage = $state('');

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

  // Credential form state
  let showCredForm: Record<string, boolean> = $state({});
  let credForm: Record<string, Record<string, string>> = $state({});
  let savingCred = $state('');
  let credMsg: Record<string, { text: string; ok: boolean }> = $state({});

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
    const pc = getProviderConfig(id);
    if (!pc) return false;
    if (id === 'anthropic') return !!(pc.apiKey || pc.authToken);
    if (id === 'openai') return !!pc.apiKey;
    if (id === 'ollama') return !!pc.baseUrl;
    return false;
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
        credForm[providerId] = { authType: 'apiKey', apiKey: '', authToken: '', baseUrl: '' };
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
        if (form.authType === 'apiKey') {
          creds.apiKey = form.apiKey;
        } else {
          creds.authToken = form.authToken;
        }
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
      const [configData] = await Promise.all([getConfig(), loadModelInfo()]);
      config = configData.config;
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
                {@const pc = getProviderConfig('anthropic')}
                <div class="detail-row">
                  <span class="detail-label">Auth:</span>
                  <span class="detail-value">{pc?.authToken ? 'OAuth Token' : 'API Key'} {pc?.apiKey ? '(****)' : ''}</span>
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
                  <label class="cred-label">Auth Type</label>
                  <div class="cred-radio-group">
                    <label class="cred-radio">
                      <input type="radio" value="apiKey" bind:group={credForm[provider.id].authType} />
                      API Key
                    </label>
                    <label class="cred-radio">
                      <input type="radio" value="authToken" bind:group={credForm[provider.id].authType} />
                      Auth Token
                    </label>
                  </div>
                </div>
                {#if credForm[provider.id].authType === 'apiKey'}
                  <div class="cred-field">
                    <label class="cred-label" for="anthropic-apikey">API Key</label>
                    <input id="anthropic-apikey" type="password" class="cred-input" bind:value={credForm[provider.id].apiKey} placeholder="sk-ant-..." />
                  </div>
                {:else}
                  <div class="cred-field">
                    <label class="cred-label" for="anthropic-token">Auth Token</label>
                    <input id="anthropic-token" type="password" class="cred-input" bind:value={credForm[provider.id].authToken} placeholder="Auth token..." />
                  </div>
                {/if}
                <div class="cred-field">
                  <label class="cred-label" for="anthropic-baseurl">Base URL (optional)</label>
                  <input id="anthropic-baseurl" type="text" class="cred-input" bind:value={credForm[provider.id].baseUrl} placeholder="https://api.anthropic.com" />
                </div>
              {:else if provider.id === 'openai'}
                <div class="cred-field">
                  <label class="cred-label" for="openai-apikey">API Key</label>
                  <input id="openai-apikey" type="password" class="cred-input" bind:value={credForm[provider.id].apiKey} placeholder="sk-..." />
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
                                <button class="btn btn-xs btn-primary" onclick={handleSaveCaps} disabled={savingCaps}>
                                  {savingCaps ? 'Saving...' : pendingModelAction ? `Save & Set as ${pendingModelAction.type === 'default' ? 'Default' : 'Fallback'}` : 'Save'}
                                </button>
                                <button class="btn btn-xs" onclick={() => { editingCaps = null; }}>Cancel</button>
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
  .provider-card:hover {
    border-color: rgba(255, 255, 255, 0.1);
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
  .btn-xs {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: var(--radius);
    background: var(--bg-void);
    border: 1px solid var(--border);
    cursor: pointer;
    color: var(--text-secondary);
    transition: all var(--duration) var(--ease);
    font-family: var(--font);
  }
  .btn-xs:hover:not(:disabled) {
    background: var(--bg-overlay);
    color: var(--text-primary);
  }
  .btn-xs:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
