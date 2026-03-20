<script lang="ts">
  import { onMount } from 'svelte';
  import { getConfig, getSystemInfo, updateConfig, saveFullConfig, getToolsConfig, saveEmailCredentials, testEmailConnection, getExportUrl, importState } from '$lib/api';
  import type { ToolMeta } from '$lib/api';
  import { logout } from '$lib/stores/auth.svelte';
  import { goto } from '$app/navigation';
  import { getTheme, setTheme } from '$lib/stores/theme.svelte';
  import type { Theme } from '$lib/stores/theme.svelte';

  let config: Record<string, unknown> | null = $state(null);
  let system: Record<string, unknown> | null = $state(null);
  let loading = $state(true);
  let toolsMeta: ToolMeta[] = $state([]);

  // Export/Import
  let importing = $state(false);
  let importMsg = $state('');
  let importFileInput: HTMLInputElement | undefined = $state();

  async function handleImport() {
    const file = importFileInput?.files?.[0];
    if (!file) return;
    importing = true;
    importMsg = '';
    try {
      const result = await importState(file);
      importMsg = result.message || 'Import complete. Restart the server to apply changes.';
    } catch (e: unknown) {
      importMsg = e instanceof Error ? e.message : 'Import failed';
    } finally {
      importing = false;
      if (importFileInput) importFileInput.value = '';
    }
  }

  // Email SMTP credentials
  let emailUser = $state('');
  let emailPass = $state('');
  let emailCredsSaving = $state(false);
  let emailCredsMsg = $state('');
  let emailTesting = $state(false);
  let emailTestResult = $state<{ success: boolean; error?: string } | null>(null);

  // Per-field feedback: key = dot path, value = { msg, ok }
  let feedback: Record<string, { msg: string; ok: boolean }> = $state({});
  let saving: Record<string, boolean> = $state({});

  // Raw JSON editor state
  let showRawJson = $state(false);
  let rawJsonText = $state('');
  let rawJsonError = $state('');
  let rawJsonSaving = $state(false);
  let rawJsonDirty = $state(false);

  async function loadData() {
    loading = true;
    try {
      const [configData, systemData, toolsData] = await Promise.all([
        getConfig().catch(() => ({ config: null })),
        getSystemInfo().catch(() => null),
        getToolsConfig().catch(() => ({ tools: [] })),
      ]);
      config = configData.config;
      system = systemData;
      toolsMeta = toolsData.tools || [];
    } catch (e) {
      console.error('Failed to load settings:', e);
    } finally {
      loading = false;
    }
  }

  /** Read a nested value from config by dot path */
  function getVal(dotPath: string): unknown {
    if (!config) return undefined;
    const parts = dotPath.split('.');
    let current: unknown = config;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /** Update a nested value in local config state */
  function setLocalVal(dotPath: string, value: unknown) {
    if (!config) return;
    const parts = dotPath.split('.');
    let current: Record<string, unknown> = config;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
    config = { ...config }; // trigger reactivity
  }

  async function saveField(dotPath: string, value: unknown) {
    saving = { ...saving, [dotPath]: true };
    feedback = { ...feedback, [dotPath]: { msg: '', ok: true } };
    try {
      await updateConfig(dotPath, value);
      setLocalVal(dotPath, value);
      feedback = { ...feedback, [dotPath]: { msg: 'Saved', ok: true } };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Save failed';
      feedback = { ...feedback, [dotPath]: { msg, ok: false } };
    } finally {
      saving = { ...saving, [dotPath]: false };
      if (feedback[dotPath]?.ok) {
        setTimeout(() => {
          if (feedback[dotPath]?.ok) {
            feedback = { ...feedback, [dotPath]: { msg: '', ok: true } };
          }
        }, 3000);
      }
    }
  }

  async function saveStringField(dotPath: string, event: Event) {
    const input = event.target as HTMLInputElement;
    await saveField(dotPath, input.value);
  }

  async function saveNumberField(dotPath: string, event: Event) {
    const input = event.target as HTMLInputElement;
    const num = Number(input.value);
    if (isNaN(num)) {
      feedback = { ...feedback, [dotPath]: { msg: 'Must be a number', ok: false } };
      return;
    }
    await saveField(dotPath, num);
  }

  async function saveToggle(dotPath: string, current: boolean) {
    await saveField(dotPath, !current);
  }

  // Full config viewer/editor
  let configViewMode: 'view' | 'edit' = $state('view');

  function getFullConfigJson(): string {
    if (!config) return '{}';
    const clean: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(config)) {
      if (key.startsWith('_')) continue;
      clean[key] = val;
    }
    return JSON.stringify(clean, null, 2);
  }

  function refreshRawJson() {
    rawJsonText = getFullConfigJson();
  }

  function handleRawJsonInput(event: Event) {
    rawJsonText = (event.target as HTMLTextAreaElement).value;
    rawJsonDirty = true;
    rawJsonError = '';
    try {
      JSON.parse(rawJsonText);
    } catch (e) {
      rawJsonError = `Invalid JSON: ${(e as Error).message}`;
    }
  }

  async function saveRawJson() {
    rawJsonError = '';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawJsonText);
    } catch (e) {
      rawJsonError = `Invalid JSON: ${(e as Error).message}`;
      return;
    }
    rawJsonSaving = true;
    try {
      await saveFullConfig(parsed);
      rawJsonDirty = false;
      configViewMode = 'view';
      await loadData();
      rawJsonError = '';
    } catch (e: unknown) {
      rawJsonError = e instanceof Error ? e.message : 'Save failed';
    } finally {
      rawJsonSaving = false;
    }
  }

  function resetRawJson() {
    refreshRawJson();
    rawJsonDirty = false;
    rawJsonError = '';
    configViewMode = 'view';
  }

  async function handleSaveEmailCreds() {
    if (!emailUser && !emailPass) return;
    emailCredsSaving = true;
    emailCredsMsg = '';
    try {
      await saveEmailCredentials({ user: emailUser || undefined, pass: emailPass || undefined });
      emailCredsMsg = 'Credentials saved';
      emailPass = '';
      setTimeout(() => { emailCredsMsg = ''; }, 5000);
    } catch (e: unknown) {
      emailCredsMsg = e instanceof Error ? e.message : 'Failed';
    } finally {
      emailCredsSaving = false;
    }
  }

  async function handleTestEmail() {
    emailTesting = true;
    emailTestResult = null;
    try {
      emailTestResult = await testEmailConnection(
        emailUser || emailPass ? { user: emailUser || undefined, pass: emailPass || undefined } : undefined,
      );
    } catch (e: unknown) {
      emailTestResult = { success: false, error: e instanceof Error ? e.message : 'Test failed' };
    } finally {
      emailTesting = false;
    }
  }

  function handleLogout() {
    logout();
    goto('/login');
  }

  onMount(loadData);
</script>

<svelte:head>
  <title>Settings - Admin - Kairo</title>
</svelte:head>

<div class="settings-page">
  <div class="page-header">
    <h1 class="page-title">Settings</h1>
    <p class="page-desc">System configuration and preferences.</p>
  </div>

  {#if loading}
    <div class="loading"><span class="spinner"></span> Loading...</div>
  {:else if !config}
    <div class="loading">Unable to load configuration.</div>
  {:else}
    <!-- Agent Settings -->
    <div class="section">
      <h2 class="section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--agent)">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
        Agent
      </h2>
      <div class="card settings-card">
        <div class="field-row">
          <div class="field-info">
            <label class="field-label" for="agent-name">Agent Name</label>
            <span class="field-hint">Display name for the assistant</span>
          </div>
          <div class="field-control">
            <div class="input-action">
              <input
                id="agent-name"
                class="input"
                type="text"
                value={getVal('agent.name') ?? ''}
                onblur={(e) => saveStringField('agent.name', e)}
                onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              {#if saving['agent.name']}<span class="field-spinner"><span class="spinner"></span></span>{/if}
            </div>
            {#if feedback['agent.name']?.msg}
              <span class="field-feedback" class:ok={feedback['agent.name'].ok} class:err={!feedback['agent.name'].ok}>
                {feedback['agent.name'].msg}
              </span>
            {/if}
          </div>
        </div>
        <div class="field-row">
          <div class="field-info">
            <label class="field-label" for="agent-maxToolRounds">Max Tool Rounds</label>
            <span class="field-hint">Maximum tool call iterations per turn (min: 1)</span>
          </div>
          <div class="field-control">
            <div class="input-action">
              <input
                id="agent-maxToolRounds"
                class="input input-narrow"
                type="number"
                min="1"
                value={getVal('agent.maxToolRounds') ?? 25}
                onblur={(e) => saveNumberField('agent.maxToolRounds', e)}
                onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              {#if saving['agent.maxToolRounds']}<span class="field-spinner"><span class="spinner"></span></span>{/if}
            </div>
            {#if feedback['agent.maxToolRounds']?.msg}
              <span class="field-feedback" class:ok={feedback['agent.maxToolRounds'].ok} class:err={!feedback['agent.maxToolRounds'].ok}>
                {feedback['agent.maxToolRounds'].msg}
              </span>
            {/if}
          </div>
        </div>
        <div class="field-row">
          <div class="field-info">
            <label class="field-label" for="agent-compactionThreshold">Compaction Threshold</label>
            <span class="field-hint">Context usage ratio that triggers compaction (0 - 1)</span>
          </div>
          <div class="field-control">
            <div class="input-action">
              <input
                id="agent-compactionThreshold"
                class="input input-narrow"
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={getVal('agent.compactionThreshold') ?? 0.75}
                onblur={(e) => saveNumberField('agent.compactionThreshold', e)}
                onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              {#if saving['agent.compactionThreshold']}<span class="field-spinner"><span class="spinner"></span></span>{/if}
            </div>
            {#if feedback['agent.compactionThreshold']?.msg}
              <span class="field-feedback" class:ok={feedback['agent.compactionThreshold'].ok} class:err={!feedback['agent.compactionThreshold'].ok}>
                {feedback['agent.compactionThreshold'].msg}
              </span>
            {/if}
          </div>
        </div>
        <div class="field-row">
          <div class="field-info">
            <label class="field-label" for="agent-keepRecentMessages">Keep Recent Messages</label>
            <span class="field-hint">Messages to preserve after compaction (min: 0)</span>
          </div>
          <div class="field-control">
            <div class="input-action">
              <input
                id="agent-keepRecentMessages"
                class="input input-narrow"
                type="number"
                min="0"
                value={getVal('agent.keepRecentMessages') ?? 10}
                onblur={(e) => saveNumberField('agent.keepRecentMessages', e)}
                onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              {#if saving['agent.keepRecentMessages']}<span class="field-spinner"><span class="spinner"></span></span>{/if}
            </div>
            {#if feedback['agent.keepRecentMessages']?.msg}
              <span class="field-feedback" class:ok={feedback['agent.keepRecentMessages'].ok} class:err={!feedback['agent.keepRecentMessages'].ok}>
                {feedback['agent.keepRecentMessages'].msg}
              </span>
            {/if}
          </div>
        </div>
      </div>
    </div>

    <!-- Thinking Settings -->
    <div class="section">
      <h2 class="section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent)">
          <path d="M12 2a8 8 0 0 0-8 8c0 3.4 2.1 6.3 5 7.4V20h6v-2.6c2.9-1.1 5-4 5-7.4a8 8 0 0 0-8-8z"></path>
          <line x1="10" y1="22" x2="14" y2="22"></line>
        </svg>
        Extended Thinking
      </h2>
      <div class="card settings-card">
        <div class="field-row">
          <div class="field-info">
            <label class="field-label">Enable Extended Thinking</label>
            <span class="field-hint">Show the LLM's chain-of-thought reasoning process</span>
          </div>
          <div class="field-control">
            <button
              class="toggle-btn"
              class:active={!!getVal('agent.thinking.enabled')}
              role="switch"
              aria-checked={!!getVal('agent.thinking.enabled')}
              disabled={!!saving['agent.thinking.enabled']}
              onclick={() => saveToggle('agent.thinking.enabled', !!getVal('agent.thinking.enabled'))}
              aria-label="Toggle extended thinking"
            >
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">{getVal('agent.thinking.enabled') ? 'Enabled' : 'Disabled'}</span>
            </button>
            {#if feedback['agent.thinking.enabled']?.msg}
              <span class="field-feedback" class:ok={feedback['agent.thinking.enabled'].ok} class:err={!feedback['agent.thinking.enabled'].ok}>
                {feedback['agent.thinking.enabled'].msg}
              </span>
            {/if}
          </div>
        </div>
        {#if getVal('agent.thinking.enabled')}
          <div class="field-row sub-field">
            <div class="field-info">
              <label class="field-label" for="thinking-budgetTokens">Budget Tokens</label>
              <span class="field-hint">Token budget for thinking (min 1024)</span>
            </div>
            <div class="field-control">
              <div class="input-action">
                <input
                  id="thinking-budgetTokens"
                  class="input input-narrow"
                  type="number"
                  min="1024"
                  value={getVal('agent.thinking.budgetTokens') ?? 10000}
                  onblur={(e) => saveNumberField('agent.thinking.budgetTokens', e)}
                  onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
                {#if saving['agent.thinking.budgetTokens']}<span class="field-spinner"><span class="spinner"></span></span>{/if}
              </div>
              {#if feedback['agent.thinking.budgetTokens']?.msg}
                <span class="field-feedback" class:ok={feedback['agent.thinking.budgetTokens'].ok} class:err={!feedback['agent.thinking.budgetTokens'].ok}>
                  {feedback['agent.thinking.budgetTokens'].msg}
                </span>
              {/if}
            </div>
          </div>
          <div class="field-row sub-field">
            <div class="field-info">
              <label class="field-label">Show in Web Chat</label>
              <span class="field-hint">Display thinking in the web UI</span>
            </div>
            <div class="field-control">
              <button
                class="toggle-btn"
                class:active={!!getVal('agent.thinking.showThinking.web')}
                role="switch"
                aria-checked={!!getVal('agent.thinking.showThinking.web')}
                disabled={!!saving['agent.thinking.showThinking.web']}
                onclick={() => saveToggle('agent.thinking.showThinking.web', !!getVal('agent.thinking.showThinking.web'))}
                aria-label="Toggle web thinking visibility"
              >
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
                <span class="toggle-label">{getVal('agent.thinking.showThinking.web') ? 'On' : 'Off'}</span>
              </button>
              {#if feedback['agent.thinking.showThinking.web']?.msg}
                <span class="field-feedback" class:ok={feedback['agent.thinking.showThinking.web'].ok} class:err={!feedback['agent.thinking.showThinking.web'].ok}>
                  {feedback['agent.thinking.showThinking.web'].msg}
                </span>
              {/if}
            </div>
          </div>
          <div class="field-row sub-field">
            <div class="field-info">
              <label class="field-label">Show in Telegram</label>
              <span class="field-hint">Send thinking as a separate message in Telegram</span>
            </div>
            <div class="field-control">
              <button
                class="toggle-btn"
                class:active={!!getVal('agent.thinking.showThinking.telegram')}
                role="switch"
                aria-checked={!!getVal('agent.thinking.showThinking.telegram')}
                disabled={!!saving['agent.thinking.showThinking.telegram']}
                onclick={() => saveToggle('agent.thinking.showThinking.telegram', !!getVal('agent.thinking.showThinking.telegram'))}
                aria-label="Toggle Telegram thinking visibility"
              >
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
                <span class="toggle-label">{getVal('agent.thinking.showThinking.telegram') ? 'On' : 'Off'}</span>
              </button>
              {#if feedback['agent.thinking.showThinking.telegram']?.msg}
                <span class="field-feedback" class:ok={feedback['agent.thinking.showThinking.telegram'].ok} class:err={!feedback['agent.thinking.showThinking.telegram'].ok}>
                  {feedback['agent.thinking.showThinking.telegram'].msg}
                </span>
              {/if}
            </div>
          </div>
          <div class="field-row sub-field">
            <div class="field-info">
              <label class="field-label">Show in WhatsApp</label>
              <span class="field-hint">Send thinking as a separate message in WhatsApp</span>
            </div>
            <div class="field-control">
              <button
                class="toggle-btn"
                class:active={!!getVal('agent.thinking.showThinking.whatsapp')}
                role="switch"
                aria-checked={!!getVal('agent.thinking.showThinking.whatsapp')}
                disabled={!!saving['agent.thinking.showThinking.whatsapp']}
                onclick={() => saveToggle('agent.thinking.showThinking.whatsapp', !!getVal('agent.thinking.showThinking.whatsapp'))}
                aria-label="Toggle WhatsApp thinking visibility"
              >
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
                <span class="toggle-label">{getVal('agent.thinking.showThinking.whatsapp') ? 'On' : 'Off'}</span>
              </button>
              {#if feedback['agent.thinking.showThinking.whatsapp']?.msg}
                <span class="field-feedback" class:ok={feedback['agent.thinking.showThinking.whatsapp'].ok} class:err={!feedback['agent.thinking.showThinking.whatsapp'].ok}>
                  {feedback['agent.thinking.showThinking.whatsapp'].msg}
                </span>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>

    <!-- Session Settings -->
    <div class="section">
      <h2 class="section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--blue)">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        Sessions
      </h2>
      <div class="card settings-card">
        <div class="field-row">
          <div class="field-info">
            <label class="field-label" for="session-resetHour">Reset Hour</label>
            <span class="field-hint">Hour of day (0-23) to auto-reset sessions</span>
          </div>
          <div class="field-control">
            <div class="input-action">
              <input
                id="session-resetHour"
                class="input input-narrow"
                type="number"
                min="0"
                max="23"
                value={getVal('session.resetHour') ?? 4}
                onblur={(e) => saveNumberField('session.resetHour', e)}
                onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              {#if saving['session.resetHour']}<span class="field-spinner"><span class="spinner"></span></span>{/if}
            </div>
            {#if feedback['session.resetHour']?.msg}
              <span class="field-feedback" class:ok={feedback['session.resetHour'].ok} class:err={!feedback['session.resetHour'].ok}>
                {feedback['session.resetHour'].msg}
              </span>
            {/if}
          </div>
        </div>
        <div class="field-row">
          <div class="field-info">
            <label class="field-label" for="session-idleMinutes">Idle Minutes</label>
            <span class="field-hint">Minutes of inactivity before session resets (0 = disabled)</span>
          </div>
          <div class="field-control">
            <div class="input-action">
              <input
                id="session-idleMinutes"
                class="input input-narrow"
                type="number"
                min="0"
                value={getVal('session.idleMinutes') ?? 0}
                onblur={(e) => saveNumberField('session.idleMinutes', e)}
                onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              {#if saving['session.idleMinutes']}<span class="field-spinner"><span class="spinner"></span></span>{/if}
            </div>
            {#if feedback['session.idleMinutes']?.msg}
              <span class="field-feedback" class:ok={feedback['session.idleMinutes'].ok} class:err={!feedback['session.idleMinutes'].ok}>
                {feedback['session.idleMinutes'].msg}
              </span>
            {/if}
          </div>
        </div>
      </div>
    </div>

    <!-- Tool Toggles (dynamic from API) -->
    <div class="section">
      <h2 class="section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--tool)">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
        </svg>
        Tools
      </h2>
      <div class="card settings-card">
        {#each toolsMeta as tool (tool.key)}
          {#each tool.fields as field (field.key)}
            {#if field.type === 'boolean' && field.key === 'enabled'}
              <div class="field-row">
                <div class="field-info">
                  <label class="field-label">{tool.label}</label>
                  <span class="field-hint">{tool.hint}</span>
                </div>
                <div class="field-control">
                  <button
                    class="toggle-btn"
                    class:active={!!getVal(`tools.${tool.key}.${field.key}`)}
                    role="switch"
                    aria-checked={!!getVal(`tools.${tool.key}.${field.key}`)}
                    disabled={!!saving[`tools.${tool.key}.${field.key}`]}
                    onclick={() => saveToggle(`tools.${tool.key}.${field.key}`, !!getVal(`tools.${tool.key}.${field.key}`))}
                    aria-label="Toggle {tool.label}"
                  >
                    <span class="toggle-track"><span class="toggle-thumb"></span></span>
                    <span class="toggle-label">{getVal(`tools.${tool.key}.${field.key}`) ? 'Enabled' : 'Disabled'}</span>
                  </button>
                  {#if feedback[`tools.${tool.key}.${field.key}`]?.msg}
                    <span class="field-feedback" class:ok={feedback[`tools.${tool.key}.${field.key}`].ok} class:err={!feedback[`tools.${tool.key}.${field.key}`].ok}>
                      {feedback[`tools.${tool.key}.${field.key}`].msg}
                    </span>
                  {/if}
                </div>
              </div>
            {:else if field.type === 'boolean' && field.key !== 'enabled' && (!field.showWhen || getVal(`tools.${tool.key}.${field.showWhen}`))}
              <div class="field-row sub-field">
                <div class="field-info">
                  <label class="field-label">{field.label || field.key}</label>
                  {#if field.hint}<span class="field-hint">{field.hint}</span>{/if}
                </div>
                <div class="field-control">
                  <button
                    class="toggle-btn"
                    class:active={!!getVal(`tools.${tool.key}.${field.key}`)}
                    role="switch"
                    aria-checked={!!getVal(`tools.${tool.key}.${field.key}`)}
                    disabled={!!saving[`tools.${tool.key}.${field.key}`]}
                    onclick={() => saveToggle(`tools.${tool.key}.${field.key}`, !!getVal(`tools.${tool.key}.${field.key}`))}
                    aria-label="Toggle {field.label || field.key}"
                  >
                    <span class="toggle-track"><span class="toggle-thumb"></span></span>
                    <span class="toggle-label">{getVal(`tools.${tool.key}.${field.key}`) ? 'On' : 'Off'}</span>
                  </button>
                  {#if feedback[`tools.${tool.key}.${field.key}`]?.msg}
                    <span class="field-feedback" class:ok={feedback[`tools.${tool.key}.${field.key}`].ok} class:err={!feedback[`tools.${tool.key}.${field.key}`].ok}>
                      {feedback[`tools.${tool.key}.${field.key}`].msg}
                    </span>
                  {/if}
                </div>
              </div>
            {:else if field.type === 'number' && (!field.showWhen || getVal(`tools.${tool.key}.${field.showWhen}`))}
              <div class="field-row sub-field">
                <div class="field-info">
                  <label class="field-label" for="tools-{tool.key}-{field.key}">{field.label || field.key}</label>
                  {#if field.hint}<span class="field-hint">{field.hint}</span>{/if}
                </div>
                <div class="field-control">
                  <div class="input-action">
                    <input
                      id="tools-{tool.key}-{field.key}"
                      class="input input-narrow"
                      type="number"
                      min={field.min ?? 0}
                      value={getVal(`tools.${tool.key}.${field.key}`) ?? ''}
                      onblur={(e) => saveNumberField(`tools.${tool.key}.${field.key}`, e)}
                      onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    />
                    {#if saving[`tools.${tool.key}.${field.key}`]}<span class="field-spinner"><span class="spinner"></span></span>{/if}
                  </div>
                  {#if feedback[`tools.${tool.key}.${field.key}`]?.msg}
                    <span class="field-feedback" class:ok={feedback[`tools.${tool.key}.${field.key}`].ok} class:err={!feedback[`tools.${tool.key}.${field.key}`].ok}>
                      {feedback[`tools.${tool.key}.${field.key}`].msg}
                    </span>
                  {/if}
                </div>
              </div>
            {:else if field.type === 'text' && (!field.showWhen || getVal(`tools.${tool.key}.${field.showWhen}`))}
              <div class="field-row sub-field">
                <div class="field-info">
                  <label class="field-label" for="tools-{tool.key}-{field.key}">{field.label || field.key}</label>
                  {#if field.hint}<span class="field-hint">{field.hint}</span>{/if}
                </div>
                <div class="field-control">
                  <div class="input-action">
                    <input
                      id="tools-{tool.key}-{field.key}"
                      class="input"
                      type="text"
                      value={getVal(`tools.${tool.key}.${field.key}`) ?? ''}
                      onblur={(e) => saveStringField(`tools.${tool.key}.${field.key}`, e)}
                      onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    />
                    {#if saving[`tools.${tool.key}.${field.key}`]}<span class="field-spinner"><span class="spinner"></span></span>{/if}
                  </div>
                  {#if feedback[`tools.${tool.key}.${field.key}`]?.msg}
                    <span class="field-feedback" class:ok={feedback[`tools.${tool.key}.${field.key}`].ok} class:err={!feedback[`tools.${tool.key}.${field.key}`].ok}>
                      {feedback[`tools.${tool.key}.${field.key}`].msg}
                    </span>
                  {/if}
                </div>
              </div>
            {/if}
          {/each}
          <!-- Email SMTP credentials (special section) -->
          {#if tool.key === 'email' && getVal('tools.email.enabled')}
            <div class="field-row sub-field">
              <div class="field-info">
                <label class="field-label" for="email-user">SMTP Username</label>
                <span class="field-hint">Usually your email address</span>
              </div>
              <div class="field-control">
                <div class="input-action">
                  <input id="email-user" class="input" type="text" bind:value={emailUser} placeholder="user@example.com" />
                </div>
              </div>
            </div>
            <div class="field-row sub-field">
              <div class="field-info">
                <label class="field-label" for="email-pass">SMTP Password</label>
                <span class="field-hint">App password or SMTP password (stored in secrets, never in config)</span>
              </div>
              <div class="field-control">
                <div class="input-action">
                  <input id="email-pass" class="input" type="password" bind:value={emailPass} placeholder="app-password" />
                </div>
              </div>
            </div>
            <div class="field-row sub-field">
              <div class="field-info">
                <span class="field-label">Credentials</span>
              </div>
              <div class="field-control">
                <button class="btn btn-sm btn-primary" onclick={handleSaveEmailCreds} disabled={emailCredsSaving || (!emailUser && !emailPass)}>
                  {emailCredsSaving ? 'Saving...' : 'Save Credentials'}
                </button>
                <button class="btn btn-sm" onclick={handleTestEmail} disabled={emailTesting}>
                  {emailTesting ? 'Testing...' : 'Test Connection'}
                </button>
              </div>
            </div>
            {#if emailCredsMsg || emailTestResult}
              <div class="field-row sub-field">
                <div class="field-info"></div>
                <div class="field-control">
                  {#if emailCredsMsg}<span class="field-feedback ok">{emailCredsMsg}</span>{/if}
                  {#if emailTestResult}
                    <span class="field-feedback" class:ok={emailTestResult.success} class:err={!emailTestResult.success}>
                      {emailTestResult.success ? 'SMTP connection OK' : emailTestResult.error}
                    </span>
                  {/if}
                </div>
              </div>
            {/if}
          {/if}
        {/each}
      </div>
    </div>

    <!-- Full Configuration -->
    <div class="section">
      <button class="collapse-toggle" onclick={() => { showRawJson = !showRawJson; if (showRawJson) { refreshRawJson(); configViewMode = 'view'; } }}>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          class="collapse-chevron" class:open={showRawJson}
        >
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
        <h2 class="section-title" style="margin-bottom: 0;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--yellow)">
            <polyline points="16 18 22 12 16 6"></polyline>
            <polyline points="8 6 2 12 8 18"></polyline>
          </svg>
          Full Configuration
        </h2>
      </button>
      {#if showRawJson}
        <div class="card raw-editor-card">
          <div class="raw-editor-header">
            <span class="raw-editor-hint">
              {#if configViewMode === 'view'}
                Read-only view of config.json. Secrets are masked.
              {:else}
                Editing config.json — secrets are preserved on save.
              {/if}
            </span>
            {#if configViewMode === 'view'}
              <button class="btn btn-xs" onclick={() => { configViewMode = 'edit'; refreshRawJson(); }} aria-label="Edit configuration">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
                Edit
              </button>
            {/if}
          </div>
          {#if configViewMode === 'view'}
            <pre class="raw-editor-pre">{getFullConfigJson()}</pre>
          {:else}
            <div class="raw-editor-warning">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
              </svg>
              Edit carefully — invalid changes may break the gateway.
            </div>
            <textarea
              class="raw-editor-textarea"
              spellcheck="false"
              value={rawJsonText}
              oninput={handleRawJsonInput}
              rows="24"
            ></textarea>
            {#if rawJsonError}
              <div class="raw-editor-error">{rawJsonError}</div>
            {/if}
            <div class="raw-editor-actions">
              <button class="btn btn-sm" onclick={resetRawJson}>Cancel</button>
              <button
                class="btn btn-sm btn-primary"
                disabled={!rawJsonDirty || !!rawJsonError || rawJsonSaving}
                onclick={saveRawJson}
              >
                {#if rawJsonSaving}<span class="spinner"></span>{/if}
                {rawJsonSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- System Info -->
    {#if system}
      <div class="section">
        <h2 class="section-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--blue)">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          System Information
        </h2>
        <div class="card settings-card">
          {#each Object.entries(system) as [key, val]}
            <div class="field-row">
              <div class="field-info">
                <span class="field-label">{key}</span>
              </div>
              <div class="field-control">
                {#if val && typeof val === 'object'}
                  <div class="system-value system-object">
                    {#each Object.entries(val as Record<string, unknown>) as [k, v]}
                      <div class="system-kv"><span class="system-key">{k}:</span> {String(v)}</div>
                    {/each}
                  </div>
                {:else}
                  <span class="system-value">{String(val)}</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Export/Import -->
    <div class="section">
      <h2 class="section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent)">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Data
      </h2>
      <div class="card settings-card">
        <div class="field-row">
          <div class="field-info">
            <span class="field-label">Export</span>
            <span class="field-hint">Download all data (config, database, secrets, WhatsApp auth, workspace)</span>
          </div>
          <div class="field-control">
            <a href={getExportUrl()} class="btn btn-sm" download>Download .tar.gz</a>
          </div>
        </div>
        <div class="field-row">
          <div class="field-info">
            <span class="field-label">Import</span>
            <span class="field-hint">Restore from a previous export. Server restart required after import.</span>
          </div>
          <div class="field-control">
            <input type="file" accept=".tar.gz,.tgz" bind:this={importFileInput} onchange={handleImport} style="display:none" />
            <button class="btn btn-sm" onclick={() => importFileInput?.click()} disabled={importing}>
              {importing ? 'Importing...' : 'Upload .tar.gz'}
            </button>
          </div>
        </div>
        {#if importMsg}
          <div class="field-row">
            <div class="field-info"></div>
            <div class="field-control">
              <span class="field-feedback" class:ok={importMsg.includes('complete')} class:err={!importMsg.includes('complete')}>{importMsg}</span>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <!-- Appearance -->
    <div class="section">
      <h2 class="section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent)">
          <circle cx="12" cy="12" r="5"></circle>
          <line x1="12" y1="1" x2="12" y2="3"></line>
          <line x1="12" y1="21" x2="12" y2="23"></line>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
          <line x1="1" y1="12" x2="3" y2="12"></line>
          <line x1="21" y1="12" x2="23" y2="12"></line>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
        </svg>
        Appearance
      </h2>
      <div class="card settings-card">
        <div class="field-row">
          <div class="field-info">
            <label class="field-label">Theme</label>
            <span class="field-hint">Choose between dark, light, or match your system preference</span>
          </div>
          <div class="field-control">
            <div class="theme-selector">
              <button
                class="theme-btn" class:active={getTheme() === 'dark'}
                onclick={() => setTheme('dark')}
                aria-label="Dark theme"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
                </svg>
                Dark
              </button>
              <button
                class="theme-btn" class:active={getTheme() === 'light'}
                onclick={() => setTheme('light')}
                aria-label="Light theme"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="5"></circle>
                  <line x1="12" y1="1" x2="12" y2="3"></line>
                  <line x1="12" y1="21" x2="12" y2="23"></line>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                  <line x1="1" y1="12" x2="3" y2="12"></line>
                  <line x1="21" y1="12" x2="23" y2="12"></line>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
                </svg>
                Light
              </button>
              <button
                class="theme-btn" class:active={getTheme() === 'system'}
                onclick={() => setTheme('system')}
                aria-label="System theme"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                  <line x1="8" y1="21" x2="16" y2="21"></line>
                  <line x1="12" y1="17" x2="12" y2="21"></line>
                </svg>
                System
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Account -->
    <div class="section">
      <h2 class="section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--red)">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <polyline points="16 17 21 12 16 7"></polyline>
          <line x1="21" y1="12" x2="9" y2="12"></line>
        </svg>
        Account
      </h2>
      <div class="card account-card">
        <p class="account-desc">Sign out of this gateway instance.</p>
        <button class="btn btn-danger" onclick={handleLogout}>
          Sign Out
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .settings-page {
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
    padding: 20px 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .section {
    margin-bottom: 32px;
  }
  .section-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  /* Settings card with field rows */
  .settings-card {
    padding: 6px 0;
  }
  .field-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 22px;
    border-bottom: 1px solid var(--border-subtle);
    transition: background var(--duration) var(--ease);
  }
  .field-row:last-child {
    border-bottom: none;
  }
  .field-row:hover {
    background: var(--bg-wash);
  }
  .field-row.sub-field {
    padding-left: 40px;
    background: rgba(0, 0, 0, 0.15);
  }
  .field-info {
    flex: 1;
    min-width: 0;
  }
  .field-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 2px;
    display: block;
  }
  .field-hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.3;
  }
  .field-control {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    min-width: 200px;
  }
  .input-action {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  .input-action .input {
    flex: 1;
  }
  .input-narrow {
    max-width: 120px;
  }
  .field-spinner {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .field-feedback {
    font-size: 11px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    animation: fadeIn 0.2s var(--ease);
  }
  .field-feedback.ok {
    color: var(--green);
    background: var(--green-subtle);
  }
  .field-feedback.err {
    color: var(--red);
    background: var(--red-subtle);
  }
  .system-value {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-secondary);
    word-break: break-all;
  }
  .system-object {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .system-kv {
    line-height: 1.5;
  }
  .system-key {
    color: var(--text-muted);
  }

  /* Toggle button */
  .toggle-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 0;
    font-family: var(--font);
    font-size: 13px;
    color: var(--text-secondary);
    transition: color var(--duration) var(--ease);
  }
  .toggle-btn:hover {
    color: var(--text-primary);
  }
  .toggle-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .toggle-track {
    position: relative;
    width: 36px;
    height: 20px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 10px;
    transition: all var(--duration) var(--ease);
    flex-shrink: 0;
  }
  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    background: var(--text-muted);
    border-radius: 50%;
    transition: all var(--duration) var(--ease);
  }
  .toggle-btn.active .toggle-track {
    background: var(--accent-subtle);
    border-color: var(--accent);
  }
  .toggle-btn.active .toggle-thumb {
    left: 18px;
    background: var(--accent);
  }
  .toggle-label {
    min-width: 56px;
  }

  /* Collapsible toggle */
  .collapse-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    margin-bottom: 12px;
    font-family: var(--font);
    color: var(--text-primary);
    transition: color var(--duration) var(--ease);
  }
  .collapse-toggle:hover {
    color: var(--accent);
  }
  .collapse-chevron {
    transition: transform var(--duration) var(--ease);
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .collapse-chevron.open {
    transform: rotate(90deg);
  }

  /* Full config viewer/editor */
  .raw-editor-card {
    padding: 0;
    overflow: hidden;
  }
  .raw-editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 18px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .raw-editor-hint {
    font-size: 12px;
    color: var(--text-muted);
  }
  .raw-editor-pre {
    margin: 0;
    padding: 18px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.7;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 500px;
    overflow-y: auto;
  }
  .raw-editor-warning {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    font-size: 12px;
    color: var(--yellow);
    background: var(--yellow-subtle);
    border-bottom: 1px solid var(--border-subtle);
  }
  .raw-editor-textarea {
    width: 100%;
    padding: 18px;
    background: var(--bg-base);
    color: var(--text-secondary);
    border: none;
    border-bottom: 1px solid var(--border-subtle);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.7;
    resize: vertical;
    outline: none;
    tab-size: 2;
    box-sizing: border-box;
  }
  .raw-editor-textarea:focus {
    color: var(--text-primary);
    background: rgba(0, 0, 0, 0.2);
  }
  .raw-editor-error {
    padding: 8px 18px;
    font-size: 12px;
    color: var(--red);
    background: var(--red-subtle);
  }
  .raw-editor-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 18px;
  }

  /* Theme selector */
  .theme-selector {
    display: flex;
    gap: 4px;
    background: var(--bg-raised);
    border-radius: var(--radius);
    padding: 3px;
  }
  .theme-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    font-family: var(--font);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--duration) var(--ease);
  }
  .theme-btn:hover {
    color: var(--text-primary);
    background: var(--bg-overlay);
  }
  .theme-btn.active {
    background: var(--accent-subtle);
    color: var(--accent);
    box-shadow: var(--shadow-sm);
  }

  /* Account */
  .account-card {
    padding: 20px 22px;
  }
  .account-desc {
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 12px;
  }
</style>
