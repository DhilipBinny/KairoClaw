<script lang="ts">
  import { onMount } from 'svelte';
  import { getSkills, getSkill, saveSkill, deleteSkill } from '$lib/api';

  interface SkillItem {
    name: string;
    description: string;
    size: number;
    modified: string | null;
  }

  let skills: SkillItem[] = $state([]);
  let loading = $state(true);
  let editingSkill = $state('');
  let editorContent = $state('');
  let saving = $state(false);
  let saveMessage = $state('');
  let deleting = $state('');

  async function loadSkills() {
    loading = true;
    try {
      const data = await getSkills();
      skills = data.skills;
    } catch (e) {
      console.error('Failed to load skills:', e);
    } finally {
      loading = false;
    }
  }

  async function openEditor(name: string) {
    editingSkill = name;
    editorContent = '';
    saveMessage = '';
    try {
      const data = await getSkill(name);
      editorContent = data.content;
    } catch (e) {
      console.error('Failed to load skill:', e);
    }
  }

  async function handleSave() {
    saving = true;
    saveMessage = '';
    try {
      await saveSkill(editingSkill, editorContent);
      saveMessage = 'Saved';
      await loadSkills();
      setTimeout(() => { saveMessage = ''; }, 3000);
    } catch (e: unknown) {
      saveMessage = `Error: ${e instanceof Error ? e.message : 'Save failed'}`;
    } finally {
      saving = false;
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete skill "${name}"? This cannot be undone.`)) return;
    deleting = name;
    try {
      await deleteSkill(name);
      await loadSkills();
    } catch (e) {
      console.error('Failed to delete skill:', e);
    } finally {
      deleting = '';
    }
  }

  function closeEditor() {
    editingSkill = '';
    editorContent = '';
    saveMessage = '';
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  onMount(loadSkills);
</script>

<svelte:head>
  <title>Skills - Admin - Kairo</title>
</svelte:head>

<div class="skills-page">
  <div class="page-header">
    <h1 class="page-title">Skills</h1>
    <p class="page-desc">Manage instruction packs that teach the agent how to handle specialized tasks. Users invoke with <code>/skill-name</code>.</p>
  </div>

  {#if loading}
    <div class="loading"><span class="spinner"></span> Loading...</div>
  {:else if editingSkill}
    <div class="editor">
      <div class="editor-header">
        <div class="editor-info">
          <div class="editor-badge">S</div>
          <div>
            <h2 class="editor-name">{editingSkill}</h2>
            <p class="editor-hint">Invoke: <code>/{editingSkill}</code></p>
          </div>
        </div>
        <div class="editor-actions">
          {#if saveMessage}
            <span class="save-message" class:error={saveMessage.startsWith('Error')}>{saveMessage}</span>
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
        placeholder="---&#10;name: skill-name&#10;description: What this skill does&#10;---&#10;&#10;# Skill instructions here..."
        spellcheck="false"
      ></textarea>
    </div>
  {:else}
    {#if skills.length === 0}
      <div class="empty">
        <p>No skills installed.</p>
        <p class="empty-hint">Skills are markdown files in <code>workspace/skills/</code>. The agent can create them with <code>/skill-creator</code>.</p>
      </div>
    {:else}
      <div class="skill-list">
        {#each skills as skill}
          <div class="card skill-row">
            <button class="skill-main" onclick={() => openEditor(skill.name)}>
              <div class="skill-badge">S</div>
              <div class="skill-info">
                <h3 class="skill-name">{skill.name}</h3>
                <p class="skill-desc">{skill.description}</p>
                <div class="skill-meta">
                  <span><code>/{skill.name}</code></span>
                  <span class="meta-sep">&middot;</span>
                  <span>{formatSize(skill.size)}</span>
                  {#if skill.modified}
                    <span class="meta-sep">&middot;</span>
                    <span>{new Date(skill.modified).toLocaleDateString()}</span>
                  {/if}
                </div>
              </div>
            </button>
            <button
              class="btn btn-small btn-danger"
              onclick={() => handleDelete(skill.name)}
              disabled={deleting === skill.name}
            >
              {deleting === skill.name ? '...' : 'Delete'}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .skills-page { max-width: 1000px; }
  .page-header { margin-bottom: 24px; }
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.3px; }
  .page-desc { color: var(--text-muted); font-size: 14px; }
  .page-desc code { background: var(--bg-raised); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .loading { color: var(--text-muted); padding: 40px 0; display: flex; align-items: center; gap: 10px; }
  .empty { padding: 60px 0; text-align: center; color: var(--text-muted); }
  .empty-hint { font-size: 13px; margin-top: 8px; }
  .empty-hint code { background: var(--bg-raised); padding: 1px 5px; border-radius: 3px; font-size: 12px; }

  .skill-list { display: flex; flex-direction: column; gap: 8px; }
  .skill-row { display: flex; align-items: center; gap: 8px; padding: 4px 12px 4px 4px; }
  .skill-main { display: flex; gap: 14px; align-items: center; flex: 1; padding: 14px; cursor: pointer; text-align: left; background: none; border: none; color: var(--text-primary); font-family: var(--font); }
  .skill-main:hover { background: var(--bg-raised); border-radius: 6px; }
  .skill-badge { width: 38px; height: 38px; border-radius: 10px; background: var(--accent)20; color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; flex-shrink: 0; }
  .skill-info { flex: 1; min-width: 0; }
  .skill-name { font-size: 14px; font-weight: 600; font-family: var(--font-mono); margin-bottom: 3px; }
  .skill-desc { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; line-height: 1.4; }
  .skill-meta { font-size: 11px; color: var(--text-muted); display: flex; gap: 4px; align-items: center; }
  .skill-meta code { background: var(--bg-raised); padding: 0 4px; border-radius: 3px; }
  .meta-sep { color: var(--text-ghost); }
  .btn-small { font-size: 12px; padding: 4px 10px; }
  .btn-danger { color: var(--red); border-color: var(--red)40; }
  .btn-danger:hover { background: var(--red)10; }

  .editor { display: flex; flex-direction: column; height: calc(100vh - 120px); }
  .editor-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
  .editor-info { display: flex; align-items: center; gap: 12px; }
  .editor-badge { width: 36px; height: 36px; border-radius: 10px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; color: #fff; flex-shrink: 0; }
  .editor-name { font-size: 18px; font-weight: 600; font-family: var(--font-mono); margin-bottom: 2px; }
  .editor-hint { font-size: 13px; color: var(--text-secondary); }
  .editor-hint code { background: var(--bg-raised); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .editor-actions { display: flex; align-items: center; gap: 8px; }
  .save-message { font-size: 12px; color: var(--green); }
  .save-message.error { color: var(--red); }
  .editor-textarea { flex: 1; min-height: 400px; resize: none; font-size: 14px; line-height: 1.7; font-family: var(--font-mono); }

  @media (max-width: 768px) {
    .page-title { font-size: 20px; }
    .editor-header { flex-direction: column; align-items: flex-start; }
    .editor-actions { width: 100%; justify-content: flex-end; }
    .editor-textarea { min-height: 250px; }
  }
</style>
