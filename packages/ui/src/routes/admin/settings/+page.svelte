<script lang="ts">
  import { onMount } from 'svelte';
  import { getConfig, getSystemInfo, updateConfig } from '$lib/api';
  import { logout } from '$lib/stores/auth.svelte';
  import { goto } from '$app/navigation';

  let config: Record<string, unknown> | null = $state(null);
  let system: Record<string, unknown> | null = $state(null);
  let loading = $state(true);
  let showRawJson = $state(false);

  // Per-field feedback: key = dot path, value = { msg, ok }
  let feedback: Record<string, { msg: string; ok: boolean }> = $state({});
  let saving: Record<string, boolean> = $state({});

  async function loadData() {
    loading = true;
    try {
      const [configData, systemData] = await Promise.all([
        getConfig().catch(() => ({ config: null })),
        getSystemInfo().catch(() => null),
      ]);
      config = configData.config;
      system = systemData;
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
      // Clear success feedback after 3 seconds
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
        Agent Settings
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

    <!-- Session Settings -->
    <div class="section">
      <h2 class="section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--blue)">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        Session Settings
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

    <!-- Tool Toggles -->
    <div class="section">
      <h2 class="section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--tool)">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
        </svg>
        Tools
      </h2>
      <div class="card settings-card">
        <div class="field-row">
          <div class="field-info">
            <label class="field-label">Shell Exec</label>
            <span class="field-hint">Allow the agent to execute shell commands</span>
          </div>
          <div class="field-control">
            <button
              class="toggle-btn"
              class:active={!!getVal('tools.exec.enabled')}
              disabled={!!saving['tools.exec.enabled']}
              onclick={() => saveToggle('tools.exec.enabled', !!getVal('tools.exec.enabled'))}
            >
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">{getVal('tools.exec.enabled') ? 'Enabled' : 'Disabled'}</span>
            </button>
            {#if feedback['tools.exec.enabled']?.msg}
              <span class="field-feedback" class:ok={feedback['tools.exec.enabled'].ok} class:err={!feedback['tools.exec.enabled'].ok}>
                {feedback['tools.exec.enabled'].msg}
              </span>
            {/if}
          </div>
        </div>
        {#if getVal('tools.exec.enabled')}
          <div class="field-row sub-field">
            <div class="field-info">
              <label class="field-label" for="tools-exec-timeout">Exec Timeout (sec)</label>
              <span class="field-hint">Maximum seconds per command execution</span>
            </div>
            <div class="field-control">
              <div class="input-action">
                <input
                  id="tools-exec-timeout"
                  class="input input-narrow"
                  type="number"
                  min="1"
                  value={getVal('tools.exec.timeout') ?? 30}
                  onblur={(e) => saveNumberField('tools.exec.timeout', e)}
                  onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
                {#if saving['tools.exec.timeout']}<span class="field-spinner"><span class="spinner"></span></span>{/if}
              </div>
              {#if feedback['tools.exec.timeout']?.msg}
                <span class="field-feedback" class:ok={feedback['tools.exec.timeout'].ok} class:err={!feedback['tools.exec.timeout'].ok}>
                  {feedback['tools.exec.timeout'].msg}
                </span>
              {/if}
            </div>
          </div>
        {/if}
        <div class="field-row">
          <div class="field-info">
            <label class="field-label">Web Search</label>
            <span class="field-hint">Allow the agent to search the web</span>
          </div>
          <div class="field-control">
            <button
              class="toggle-btn"
              class:active={!!getVal('tools.webSearch.enabled')}
              disabled={!!saving['tools.webSearch.enabled']}
              onclick={() => saveToggle('tools.webSearch.enabled', !!getVal('tools.webSearch.enabled'))}
            >
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">{getVal('tools.webSearch.enabled') ? 'Enabled' : 'Disabled'}</span>
            </button>
            {#if feedback['tools.webSearch.enabled']?.msg}
              <span class="field-feedback" class:ok={feedback['tools.webSearch.enabled'].ok} class:err={!feedback['tools.webSearch.enabled'].ok}>
                {feedback['tools.webSearch.enabled'].msg}
              </span>
            {/if}
          </div>
        </div>
        <div class="field-row">
          <div class="field-info">
            <label class="field-label">Web Fetch</label>
            <span class="field-hint">Allow the agent to fetch web pages</span>
          </div>
          <div class="field-control">
            <button
              class="toggle-btn"
              class:active={!!getVal('tools.webFetch.enabled')}
              disabled={!!saving['tools.webFetch.enabled']}
              onclick={() => saveToggle('tools.webFetch.enabled', !!getVal('tools.webFetch.enabled'))}
            >
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">{getVal('tools.webFetch.enabled') ? 'Enabled' : 'Disabled'}</span>
            </button>
            {#if feedback['tools.webFetch.enabled']?.msg}
              <span class="field-feedback" class:ok={feedback['tools.webFetch.enabled'].ok} class:err={!feedback['tools.webFetch.enabled'].ok}>
                {feedback['tools.webFetch.enabled'].msg}
              </span>
            {/if}
          </div>
        </div>
        {#if getVal('tools.webFetch.enabled')}
          <div class="field-row sub-field">
            <div class="field-info">
              <label class="field-label" for="tools-webFetch-maxChars">Max Characters</label>
              <span class="field-hint">Maximum characters to fetch from a web page</span>
            </div>
            <div class="field-control">
              <div class="input-action">
                <input
                  id="tools-webFetch-maxChars"
                  class="input input-narrow"
                  type="number"
                  min="0"
                  value={getVal('tools.webFetch.maxChars') ?? 50000}
                  onblur={(e) => saveNumberField('tools.webFetch.maxChars', e)}
                  onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
                {#if saving['tools.webFetch.maxChars']}<span class="field-spinner"><span class="spinner"></span></span>{/if}
              </div>
              {#if feedback['tools.webFetch.maxChars']?.msg}
                <span class="field-feedback" class:ok={feedback['tools.webFetch.maxChars'].ok} class:err={!feedback['tools.webFetch.maxChars'].ok}>
                  {feedback['tools.webFetch.maxChars'].msg}
                </span>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>

    <!-- Raw JSON (collapsible) -->
    <div class="section">
      <button class="collapse-toggle" onclick={() => showRawJson = !showRawJson}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="collapse-chevron"
          class:open={showRawJson}
        >
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
        <h2 class="section-title" style="margin-bottom: 0;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent)">
            <polyline points="16 18 22 12 16 6"></polyline>
            <polyline points="8 6 2 12 8 18"></polyline>
          </svg>
          Raw Configuration
        </h2>
      </button>
      {#if showRawJson}
        <div class="card config-view">
          <pre class="config-json">{JSON.stringify(config, null, 2)}</pre>
        </div>
      {/if}
    </div>

    <!-- System info -->
    {#if system}
      <div class="section">
        <h2 class="section-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--blue)">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>
          System Information
        </h2>
        <div class="card config-view">
          <pre class="config-json">{JSON.stringify(system, null, 2)}</pre>
        </div>
      </div>
    {/if}

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
    background: rgba(255, 255, 255, 0.01);
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
  .field-spinner.inline {
    display: inline-flex;
    margin-left: 8px;
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

  /* Collapsible raw JSON */
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
  .config-view {
    padding: 18px;
    overflow-x: auto;
  }
  .config-json {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.7;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
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
