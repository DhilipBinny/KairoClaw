<script lang="ts">
  import { onMount } from 'svelte';
  import { getWorkspaceFiles, getWorkspaceFile, saveWorkspaceFile } from '$lib/api';

  interface WorkspaceFile {
    name: string;
    exists: boolean;
    size: number;
    modified: string | null;
  }

  let files: WorkspaceFile[] = $state([]);
  let loading = $state(true);
  let editingFile = $state('');
  let editorContent = $state('');
  let saving = $state(false);
  let saveMessage = $state('');

  const fileDescriptions: Record<string, string> = {
    'IDENTITY.md': 'Core identity and behavior of the AI agent',
    'SOUL.md': 'Personality, tone, and communication style',
    'USER.md': 'Information about the user (preferences, context)',
    'AGENTS.md': 'Multi-agent coordination and delegation rules',
    'MEMORY.md': 'Persistent memory and learned context',
  };

  const fileColors: Record<string, string> = {
    'IDENTITY.md': 'var(--accent)',
    'SOUL.md': 'var(--cost)',
    'USER.md': 'var(--blue)',
    'AGENTS.md': 'var(--agent)',
    'MEMORY.md': 'var(--green)',
  };

  async function loadFiles() {
    loading = true;
    try {
      const data = await getWorkspaceFiles();
      files = data.files;
    } catch (e) {
      console.error('Failed to load workspace files:', e);
    } finally {
      loading = false;
    }
  }

  async function openEditor(name: string) {
    editingFile = name;
    editorContent = '';
    saveMessage = '';
    try {
      const data = await getWorkspaceFile(name);
      editorContent = data.content;
    } catch (e) {
      console.error('Failed to load file:', e);
    }
  }

  async function handleSave() {
    saving = true;
    saveMessage = '';
    try {
      await saveWorkspaceFile(editingFile, editorContent);
      saveMessage = 'Saved successfully';
      await loadFiles();
      setTimeout(() => { saveMessage = ''; }, 3000);
    } catch (e: unknown) {
      saveMessage = `Error: ${e instanceof Error ? e.message : 'Save failed'}`;
    } finally {
      saving = false;
    }
  }

  function closeEditor() {
    editingFile = '';
    editorContent = '';
    saveMessage = '';
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  onMount(loadFiles);
</script>

<svelte:head>
  <title>Personas - Admin - Kairo</title>
</svelte:head>

<div class="personas-page">
  <div class="page-header">
    <h1 class="page-title">Personas</h1>
    <p class="page-desc">Edit workspace files that define your AI agent's personality and behavior.</p>
  </div>

  {#if loading}
    <div class="loading"><span class="spinner"></span> Loading...</div>
  {:else if editingFile}
    <!-- Editor view -->
    <div class="editor">
      <div class="editor-header">
        <div class="editor-info">
          <div class="editor-file-badge" style="background: {fileColors[editingFile] || 'var(--accent)'}">
            {editingFile.charAt(0)}
          </div>
          <div>
            <h2 class="editor-filename">{editingFile}</h2>
            <p class="editor-desc">{fileDescriptions[editingFile] || ''}</p>
          </div>
        </div>
        <div class="editor-actions">
          {#if saveMessage}
            <span class="save-message" class:error={saveMessage.startsWith('Error')}>
              {saveMessage}
            </span>
          {/if}
          <button class="btn btn-primary" onclick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button class="btn" onclick={closeEditor}>Close</button>
        </div>
      </div>
      <textarea
        class="input editor-textarea"
        bind:value={editorContent}
        placeholder="Start writing..."
        spellcheck="false"
      ></textarea>
    </div>
  {:else}
    <!-- File cards -->
    <div class="file-grid">
      {#each files as file}
        <button class="card file-card" onclick={() => openEditor(file.name)}>
          <div class="file-icon" style="background: {fileColors[file.name] || 'var(--accent)'}20; color: {fileColors[file.name] || 'var(--accent)'}">
            {file.name.charAt(0)}
          </div>
          <div class="file-info">
            <h3 class="file-name">{file.name}</h3>
            <p class="file-desc">{fileDescriptions[file.name] || ''}</p>
            <div class="file-meta">
              {#if file.exists}
                <span>{formatSize(file.size)}</span>
                {#if file.modified}
                  <span class="meta-sep">&middot;</span>
                  <span>{new Date(file.modified).toLocaleDateString()}</span>
                {/if}
              {:else}
                <span class="file-new">Not created yet</span>
              {/if}
            </div>
          </div>
          <svg class="file-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .personas-page {
    max-width: 900px;
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
  .file-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 12px;
  }
  .file-card {
    display: flex;
    gap: 16px;
    align-items: center;
    padding: 18px 20px;
    cursor: pointer;
    text-align: left;
    border: 1px solid var(--border);
    font-family: var(--font);
    color: var(--text-primary);
    transition: all var(--duration) var(--ease);
    width: 100%;
  }
  .file-card:hover {
    border-color: var(--border);
    background: var(--bg-raised);
  }
  .file-card:hover .file-arrow {
    opacity: 1;
    transform: translateX(2px);
  }
  .file-icon {
    width: 42px;
    height: 42px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 17px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .file-info {
    flex: 1;
    min-width: 0;
  }
  .file-name {
    font-size: 14px;
    font-weight: 600;
    font-family: var(--font-mono);
    margin-bottom: 3px;
  }
  .file-desc {
    font-size: 12px;
    color: var(--text-secondary);
    margin-bottom: 4px;
    line-height: 1.4;
  }
  .file-meta {
    font-size: 11px;
    color: var(--text-muted);
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .meta-sep {
    color: var(--text-ghost);
  }
  .file-new {
    color: var(--yellow);
  }
  .file-arrow {
    color: var(--text-ghost);
    opacity: 0;
    transition: all var(--duration) var(--ease);
    flex-shrink: 0;
  }

  /* Editor */
  .editor {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 120px);
  }
  .editor-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    flex-wrap: wrap;
    gap: 12px;
  }
  .editor-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .editor-file-badge {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 700;
    color: #fff;
    flex-shrink: 0;
  }
  .editor-filename {
    font-size: 18px;
    font-weight: 600;
    font-family: var(--font-mono);
    margin-bottom: 2px;
  }
  .editor-desc {
    font-size: 13px;
    color: var(--text-secondary);
  }
  .editor-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .save-message {
    font-size: 12px;
    color: var(--green);
  }
  .save-message.error {
    color: var(--red);
  }
  .editor-textarea {
    flex: 1;
    min-height: 400px;
    resize: none;
    font-size: 14px;
    line-height: 1.7;
  }

  @media (max-width: 768px) {
    .page-title { font-size: 20px; }
    .page-desc { font-size: 13px; }
    .file-grid {
      grid-template-columns: 1fr;
    }
    .editor-header {
      flex-direction: column;
      align-items: flex-start;
    }
    .editor-actions { width: 100%; justify-content: flex-end; }
    .editor-textarea { min-height: 250px; }
    .editor-filename { font-size: 16px; }
  }
</style>
