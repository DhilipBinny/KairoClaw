<script lang="ts">
  import { onMount } from 'svelte';
  import { getSkills, getSkill, saveSkill, deleteSkill, getUserSkills, getUserSkill, deleteUserSkill } from '$lib/api';

  interface SkillItem {
    name: string;
    description: string;
    size: number;
    modified: string | null;
  }

  interface UserSkillGroup {
    scopeKey: string;
    skills: SkillItem[];
  }

  // ── Shared skills state ───────────────────────────────────
  let skills: SkillItem[] = $state([]);
  let loading = $state(true);
  let editingSkill = $state('');      // name of skill being edited
  let isCreating = $state(false);     // true when creating a new skill
  let newSkillName = $state('');      // name input during create
  let editorContent = $state('');
  let saving = $state(false);
  let saveMessage = $state('');
  let deleting = $state('');

  // ── User skills state ─────────────────────────────────────
  let userGroups: UserSkillGroup[] = $state([]);
  let userSkillsLoading = $state(true);
  let viewingUserSkill = $state<{ scopeKey: string; name: string } | null>(null);
  let userSkillContent = $state('');
  let deletingUserSkill = $state('');

  // ── Shared skill actions ──────────────────────────────────

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

  async function loadUserSkills() {
    userSkillsLoading = true;
    try {
      const data = await getUserSkills();
      userGroups = data.users;
    } catch (e) {
      console.error('Failed to load user skills:', e);
    } finally {
      userSkillsLoading = false;
    }
  }

  function openCreate() {
    isCreating = true;
    editingSkill = '';
    newSkillName = '';
    saveMessage = '';
    editorContent = `---\nname: skill-name\ndescription: What this skill does\n---\n\n# Skill Name\n\nWhen asked to [trigger], follow these guidelines:\n\n## Process\n1. \n\n## Rules\n- \n\n## Output\n- `;
  }

  async function openEditor(name: string) {
    isCreating = false;
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
    const targetName = isCreating
      ? newSkillName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      : editingSkill;

    if (!targetName) {
      saveMessage = 'Error: skill name is required';
      return;
    }

    saving = true;
    saveMessage = '';
    try {
      await saveSkill(targetName, editorContent);
      saveMessage = 'Saved';
      isCreating = false;
      editingSkill = targetName;
      newSkillName = '';
      await loadSkills();
      setTimeout(() => { saveMessage = ''; }, 3000);
    } catch (e: unknown) {
      saveMessage = `Error: ${e instanceof Error ? e.message : 'Save failed'}`;
    } finally {
      saving = false;
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete shared skill "${name}"? This cannot be undone.`)) return;
    deleting = name;
    try {
      await deleteSkill(name);
      if (editingSkill === name) closeEditor();
      await loadSkills();
    } catch (e) {
      console.error('Failed to delete skill:', e);
    } finally {
      deleting = '';
    }
  }

  function closeEditor() {
    editingSkill = '';
    isCreating = false;
    newSkillName = '';
    editorContent = '';
    saveMessage = '';
  }

  // ── User skill actions ────────────────────────────────────

  async function openUserSkill(scopeKey: string, name: string) {
    viewingUserSkill = { scopeKey, name };
    userSkillContent = '';
    try {
      const data = await getUserSkill(scopeKey, name);
      userSkillContent = data.content;
    } catch (e) {
      console.error('Failed to load user skill:', e);
    }
  }

  function closeUserSkill() {
    viewingUserSkill = null;
    userSkillContent = '';
  }

  async function handleDeleteUserSkill(scopeKey: string, name: string) {
    if (!confirm(`Delete skill "${name}" for user "${scopeKey}"? This cannot be undone.`)) return;
    const key = `${scopeKey}/${name}`;
    deletingUserSkill = key;
    try {
      await deleteUserSkill(scopeKey, name);
      if (viewingUserSkill?.scopeKey === scopeKey && viewingUserSkill?.name === name) closeUserSkill();
      await loadUserSkills();
    } catch (e) {
      console.error('Failed to delete user skill:', e);
    } finally {
      deletingUserSkill = '';
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  function formatScope(scopeKey: string): string {
    // telegram:12345 → Telegram · 12345
    const [channel, id] = scopeKey.split(':');
    if (channel && id) return `${channel.charAt(0).toUpperCase() + channel.slice(1)} · ${id}`;
    return scopeKey;
  }

  onMount(() => {
    loadSkills();
    loadUserSkills();
  });
</script>

<svelte:head>
  <title>Skills - Admin - Kairo</title>
</svelte:head>

<div class="skills-page">
  <!-- ── Shared Skills ─────────────────────────────────── -->
  <div class="section-header">
    <div>
      <h1 class="page-title">Skills</h1>
      <p class="page-desc">Shared instruction packs visible to all users. Invoke with <code>/skill-name</code>.</p>
    </div>
    {#if !editingSkill && !isCreating}
      <button class="btn btn-primary" onclick={openCreate}>+ New Skill</button>
    {/if}
  </div>

  {#if loading}
    <div class="loading"><span class="spinner"></span> Loading...</div>
  {:else if isCreating || editingSkill}
    <!-- ── Editor (create or edit) ── -->
    <div class="editor">
      <div class="editor-header">
        <div class="editor-info">
          <div class="editor-badge">{isCreating ? '+' : 'S'}</div>
          <div>
            {#if isCreating}
              <input
                class="input name-input"
                bind:value={newSkillName}
                placeholder="skill-name (lowercase, hyphens)"
                spellcheck="false"
              />
              <p class="editor-hint">Will be invoked as <code>/{newSkillName || 'skill-name'}</code></p>
            {:else}
              <h2 class="editor-name">{editingSkill}</h2>
              <p class="editor-hint">Invoke: <code>/{editingSkill}</code></p>
            {/if}
          </div>
        </div>
        <div class="editor-actions">
          {#if saveMessage}
            <span class="save-message" class:error={saveMessage.startsWith('Error')}>{saveMessage}</span>
          {/if}
          <button class="btn btn-primary" onclick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : isCreating ? 'Create' : 'Save'}
          </button>
          {#if !isCreating}
            <button class="btn btn-small btn-danger" onclick={() => handleDelete(editingSkill)} disabled={deleting === editingSkill}>
              {deleting === editingSkill ? '...' : 'Delete'}
            </button>
          {/if}
          <button class="btn" onclick={closeEditor}>Cancel</button>
        </div>
      </div>
      <textarea
        class="input editor-textarea"
        bind:value={editorContent}
        placeholder="---&#10;name: skill-name&#10;description: What this skill does&#10;---&#10;&#10;# Skill instructions here..."
        spellcheck="false"
      ></textarea>
    </div>
  {:else if skills.length === 0}
    <div class="empty">
      <p>No shared skills installed.</p>
      <p class="empty-hint">Click <strong>+ New Skill</strong> to create one, or users can create personal skills with <code>/skill-creator</code>.</p>
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

  <!-- ── User Skills ─────────────────────────────────── -->
  {#if !isCreating && !editingSkill}
    <div class="user-section">
      <div class="user-section-header">
        <h2 class="user-section-title">User Skills</h2>
        <p class="user-section-desc">Personal skills created by users via <code>/skill-creator</code>. Only visible to the user who created them.</p>
      </div>

      {#if userSkillsLoading}
        <div class="loading small"><span class="spinner"></span> Loading...</div>
      {:else if viewingUserSkill}
        <!-- ── User skill viewer ── -->
        <div class="editor">
          <div class="editor-header">
            <div class="editor-info">
              <div class="editor-badge user-badge">U</div>
              <div>
                <h2 class="editor-name">{viewingUserSkill.name}</h2>
                <p class="editor-hint">User: <code>{formatScope(viewingUserSkill.scopeKey)}</code></p>
              </div>
            </div>
            <div class="editor-actions">
              <button
                class="btn btn-small btn-danger"
                onclick={() => handleDeleteUserSkill(viewingUserSkill!.scopeKey, viewingUserSkill!.name)}
                disabled={deletingUserSkill === `${viewingUserSkill.scopeKey}/${viewingUserSkill.name}`}
              >
                Delete
              </button>
              <button class="btn" onclick={closeUserSkill}>Close</button>
            </div>
          </div>
          <textarea
            class="input editor-textarea"
            value={userSkillContent}
            readonly
            spellcheck="false"
          ></textarea>
        </div>
      {:else if userGroups.length === 0}
        <div class="empty small">
          <p>No user skills created yet.</p>
        </div>
      {:else}
        {#each userGroups as group}
          <div class="user-group">
            <div class="user-group-label">
              <span class="scope-badge">U</span>
              <span class="scope-key">{formatScope(group.scopeKey)}</span>
              <span class="scope-count">{group.skills.length} skill{group.skills.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="skill-list">
              {#each group.skills as skill}
                <div class="card skill-row">
                  <button class="skill-main" onclick={() => openUserSkill(group.scopeKey, skill.name)}>
                    <div class="skill-badge user-badge">U</div>
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
                    onclick={() => handleDeleteUserSkill(group.scopeKey, skill.name)}
                    disabled={deletingUserSkill === `${group.scopeKey}/${skill.name}`}
                  >
                    {deletingUserSkill === `${group.scopeKey}/${skill.name}` ? '...' : 'Delete'}
                  </button>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .skills-page { max-width: 1000px; }
  .section-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; gap: 16px; }
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.3px; }
  .page-desc { color: var(--text-muted); font-size: 14px; }
  .page-desc code { background: var(--bg-raised); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .loading { color: var(--text-muted); padding: 40px 0; display: flex; align-items: center; gap: 10px; }
  .loading.small { padding: 20px 0; }
  .empty { padding: 60px 0; text-align: center; color: var(--text-muted); }
  .empty.small { padding: 24px 0; }
  .empty-hint { font-size: 13px; margin-top: 8px; }
  .empty-hint code { background: var(--bg-raised); padding: 1px 5px; border-radius: 3px; font-size: 12px; }

  .skill-list { display: flex; flex-direction: column; gap: 8px; }
  .skill-row { display: flex; align-items: center; gap: 8px; padding: 4px 12px 4px 4px; }
  .skill-main { display: flex; gap: 14px; align-items: center; flex: 1; padding: 14px; cursor: pointer; text-align: left; background: none; border: none; color: var(--text-primary); font-family: var(--font); }
  .skill-main:hover { background: var(--bg-raised); border-radius: 6px; }
  .skill-badge { width: 38px; height: 38px; border-radius: 10px; background: var(--accent)20; color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; flex-shrink: 0; }
  .user-badge { background: var(--text-muted)20; color: var(--text-muted); }
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
  .editor-badge.user-badge { background: var(--bg-raised); color: var(--text-muted); }
  .editor-name { font-size: 18px; font-weight: 600; font-family: var(--font-mono); margin-bottom: 2px; }
  .editor-hint { font-size: 13px; color: var(--text-secondary); }
  .editor-hint code { background: var(--bg-raised); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .editor-actions { display: flex; align-items: center; gap: 8px; }
  .save-message { font-size: 12px; color: var(--green); }
  .save-message.error { color: var(--red); }
  .editor-textarea { flex: 1; min-height: 400px; resize: none; font-size: 14px; line-height: 1.7; font-family: var(--font-mono); }
  .name-input { font-family: var(--font-mono); font-size: 16px; font-weight: 600; padding: 4px 8px; width: 280px; margin-bottom: 4px; }

  /* User skills section */
  .user-section { margin-top: 48px; border-top: 1px solid var(--border); padding-top: 32px; }
  .user-section-header { margin-bottom: 20px; }
  .user-section-title { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
  .user-section-desc { font-size: 13px; color: var(--text-muted); }
  .user-section-desc code { background: var(--bg-raised); padding: 1px 5px; border-radius: 3px; font-size: 12px; }

  .user-group { margin-bottom: 24px; }
  .user-group-label { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .scope-badge { width: 22px; height: 22px; border-radius: 6px; background: var(--bg-raised); color: var(--text-muted); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; }
  .scope-key { font-size: 13px; font-weight: 600; font-family: var(--font-mono); color: var(--text-secondary); }
  .scope-count { font-size: 12px; color: var(--text-muted); margin-left: 4px; }

  @media (max-width: 768px) {
    .section-header { flex-direction: column; align-items: flex-start; }
    .page-title { font-size: 20px; }
    .editor-header { flex-direction: column; align-items: flex-start; }
    .editor-actions { width: 100%; justify-content: flex-end; }
    .editor-textarea { min-height: 250px; }
    .name-input { width: 100%; }
  }
</style>
