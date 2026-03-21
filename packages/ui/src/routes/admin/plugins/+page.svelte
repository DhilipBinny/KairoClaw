<script lang="ts">
  import { onMount } from 'svelte';
  import { getPlugins, savePlugins } from '$lib/api';

  let pluginsJson = $state('');
  let loading = $state(true);
  let saving = $state(false);
  let feedback = $state<{ msg: string; ok: boolean } | null>(null);
  let parseError = $state('');

  onMount(async () => {
    try {
      const { plugins } = await getPlugins();
      pluginsJson = JSON.stringify(plugins, null, 2);
    } catch (e: unknown) {
      feedback = { msg: e instanceof Error ? e.message : 'Failed to load plugins', ok: false };
    } finally {
      loading = false;
    }
  });

  function validateJson() {
    try {
      JSON.parse(pluginsJson);
      parseError = '';
    } catch (e: unknown) {
      parseError = e instanceof Error ? e.message : 'Invalid JSON';
    }
  }

  async function handleSave() {
    parseError = '';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(pluginsJson);
    } catch (e: unknown) {
      parseError = e instanceof Error ? e.message : 'Invalid JSON';
      return;
    }

    saving = true;
    feedback = null;
    try {
      await savePlugins(parsed);
      feedback = { msg: 'Saved. Plugins reloaded.', ok: true };
    } catch (e: unknown) {
      feedback = { msg: e instanceof Error ? e.message : 'Save failed', ok: false };
    } finally {
      saving = false;
    }
  }
</script>

<div class="page-header">
  <h1 class="page-title">Plugins</h1>
  <p class="page-desc">CLI and HTTP API plugins. Stored in <code>plugins.json</code>, separate from config.</p>
</div>

{#if loading}
  <div class="loading">Loading...</div>
{:else}
  <div class="editor-section">
    <textarea
      class="json-editor"
      class:has-error={!!parseError}
      bind:value={pluginsJson}
      oninput={validateJson}
      spellcheck="false"
      rows="24"
    ></textarea>

    {#if parseError}
      <div class="parse-error">{parseError}</div>
    {/if}

    <div class="actions">
      <button class="btn-save" onclick={handleSave} disabled={saving || !!parseError}>
        {saving ? 'Saving...' : 'Save & Reload'}
      </button>
      {#if feedback}
        <span class="feedback" class:ok={feedback.ok} class:err={!feedback.ok}>
          {feedback.msg}
        </span>
      {/if}
    </div>
  </div>

  <div class="help-section">
    <details>
      <summary>Example: HTTP plugin</summary>
      <pre>{JSON.stringify({
  http: [{
    name: "my_api",
    baseUrl: "http://10.0.2.20:5006",
    description: "My local API",
    enabled: true,
    timeout: 120,
    endpoints: [{
      name: "health",
      method: "GET",
      path: "/health",
      description: "Health check",
      parameters: {}
    }, {
      name: "generate",
      method: "POST",
      path: "/generate_base64",
      description: "Generate something",
      parameters: {
        prompt: { type: "string", required: true, description: "Input prompt" }
      }
    }]
  }]
}, null, 2)}</pre>
    </details>

    <details>
      <summary>Example: CLI plugin</summary>
      <pre>{JSON.stringify({
  cli: [{
    name: "gh",
    command: "gh",
    description: "GitHub CLI",
    enabled: true,
    timeout: 30,
    allowedSubcommands: ["pr", "issue", "repo"],
    blockedSubcommands: ["auth", "ssh-key"],
    requireConfirmation: ["pr merge", "repo delete"]
  }]
}, null, 2)}</pre>
    </details>
  </div>
{/if}

<style>
  .page-header {
    margin-bottom: 24px;
  }
  .page-title {
    font-size: 22px;
    font-weight: 700;
    margin: 0 0 4px;
  }
  .page-desc {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
  }
  .page-desc code {
    font-family: var(--font-mono);
    background: var(--bg-raised);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 12px;
  }
  .loading {
    color: var(--text-muted);
    font-size: 14px;
    padding: 40px 0;
    text-align: center;
  }
  .editor-section {
    max-width: 1000px;
    margin-bottom: 24px;
  }
  .json-editor {
    width: 100%;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    resize: vertical;
    tab-size: 2;
    box-sizing: border-box;
  }
  .json-editor:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }
  .json-editor.has-error {
    border-color: var(--red);
  }
  .parse-error {
    font-size: 12px;
    color: var(--red);
    margin-top: 6px;
    font-family: var(--font-mono);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
  }
  .btn-save {
    padding: 8px 20px;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
    border: none;
    cursor: pointer;
    font-family: var(--font);
    background: var(--accent);
    color: #fff;
    transition: filter 0.15s ease;
  }
  .btn-save:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .btn-save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .feedback {
    font-size: 13px;
    font-weight: 500;
  }
  .feedback.ok { color: var(--green, #22c55e); }
  .feedback.err { color: var(--red); }
  .help-section {
    max-width: 1000px;
  }
  .help-section details {
    margin-bottom: 8px;
  }
  .help-section summary {
    font-size: 13px;
    color: var(--text-secondary);
    cursor: pointer;
    font-weight: 500;
  }
  .help-section pre {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
    overflow-x: auto;
    margin-top: 6px;
    color: var(--text-secondary);
  }

  @media (max-width: 768px) {
    .page-title { font-size: 20px; }
    .page-desc { font-size: 13px; }
    .json-editor {
      font-size: 12px;
      padding: 12px;
      rows: 18;
    }
    .btn-save {
      width: 100%;
    }
    .actions {
      flex-direction: column;
      align-items: stretch;
    }
    .help-section pre {
      font-size: 11px;
      padding: 10px;
    }
  }
</style>
