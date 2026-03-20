<script lang="ts">
  import { getSessions, loadSessions, type SessionInfo } from '$lib/stores/sessions.svelte';
  import { setSessionKey, getCurrentSessionKey, loadHistory, clearMessages } from '$lib/stores/chat.svelte';
  import { renameSession, deleteSession } from '$lib/api';

  let sessions = $derived(getSessions());
  let currentKey = $derived(getCurrentSessionKey());

  let editingId: string | null = $state(null);
  let editValue: string = $state('');
  let editInput: HTMLInputElement | undefined = $state();

  function selectSession(session: SessionInfo) {
    if (editingId) return; // Don't switch while editing
    setSessionKey(session.sessionKey || session.id);
    clearMessages();
    loadHistory(session.id);
  }

  function newChat() {
    const key = `chat-${Date.now().toString(36)}`;
    setSessionKey(key);
    clearMessages();
  }

  function startEdit(e: Event, session: SessionInfo) {
    e.stopPropagation();
    editingId = session.id;
    editValue = session.title || '';
    // Focus the input after render
    requestAnimationFrame(() => editInput?.focus());
  }

  async function saveEdit(session: SessionInfo) {
    if (editingId !== session.id) return;
    const newTitle = editValue.trim();
    if (newTitle && newTitle !== session.title) {
      await renameSession(session.id, newTitle);
      await loadSessions();
    }
    editingId = null;
  }

  function cancelEdit() {
    editingId = null;
  }

  function handleEditKeydown(e: KeyboardEvent, session: SessionInfo) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit(session);
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  }

  async function handleDelete(e: Event, session: SessionInfo) {
    e.stopPropagation();
    if (confirm('Delete this session?')) {
      await deleteSession(session.id);
      await loadSessions();
      // If we deleted the current session, start a new one
      if (currentKey === (session.sessionKey || session.id)) {
        newChat();
      }
    }
  }

  $effect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 30000);
    return () => clearInterval(interval);
  });
</script>

<div class="session-list">
  <div class="session-header">
    <span class="session-title">Sessions</span>
    <button class="btn btn-sm btn-primary new-chat-btn" onclick={newChat}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      New
    </button>
  </div>

  <div class="session-items">
    {#each sessions as session (session.id)}
      <div
        class="session-item"
        class:active={currentKey === (session.sessionKey || session.id)}
        role="button"
        tabindex="0"
        onclick={() => selectSession(session)}
        onkeydown={(e) => e.key === 'Enter' && selectSession(session)}
      >
        {#if editingId === session.id}
          <!-- Inline edit mode -->
          <input
            bind:this={editInput}
            class="session-edit-input"
            type="text"
            bind:value={editValue}
            onkeydown={(e) => handleEditKeydown(e, session)}
            onblur={() => saveEdit(session)}
            onclick={(e) => e.stopPropagation()}
          />
        {:else}
          <!-- Normal display -->
          <div class="session-row">
            <div class="session-info">
              <div class="session-channel">
                <span class="session-channel-icon">
                  {session.channel === 'web' ? '\uD83C\uDF10' : session.channel === 'telegram' ? '\uD83D\uDCF1' : '\uD83D\uDD0C'}
                </span>
                <span class="session-channel-text">{session.title || `${session.channel} chat`}</span>
              </div>
              <div class="session-meta">
                {session.turns} turn{session.turns !== 1 ? 's' : ''}
                &middot;
                {new Date(session.updatedAt || session.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div class="session-actions">
              <button
                class="session-action-btn"
                title="Rename"
                onclick={(e) => startEdit(e, session)}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
              </button>
              <button
                class="session-action-btn delete"
                title="Delete"
                onclick={(e) => handleDelete(e, session)}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
              </button>
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <div class="session-empty">No sessions yet</div>
    {/each}
  </div>
</div>

<style>
  .session-list {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .session-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .session-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.8px;
  }
  .new-chat-btn {
    gap: 4px;
    padding: 4px 10px;
    font-size: 12px;
  }
  .session-items {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }
  .session-item {
    width: 100%;
    text-align: left;
    padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
    color: var(--text-primary);
    font-family: var(--font);
    transition: all 0.15s ease;
  }
  .session-item:hover {
    background: var(--bg-raised);
  }
  .session-item:hover .session-actions {
    opacity: 1;
  }
  .session-item.active {
    background: var(--accent-subtle);
    border-color: var(--border-accent);
  }
  .session-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }
  .session-info {
    flex: 1;
    min-width: 0;
  }
  .session-channel {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 2px;
  }
  .session-channel-icon {
    font-size: 12px;
    flex-shrink: 0;
  }
  .session-channel-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .session-meta {
    font-size: 11px;
    color: var(--text-muted);
    padding-left: 18px;
  }
  .session-actions {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.15s ease;
    flex-shrink: 0;
  }
  .session-action-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 5px;
    border-radius: 4px;
    line-height: 1;
    color: var(--text-muted);
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .session-action-btn:hover {
    color: var(--text-primary);
    background: var(--bg-overlay);
  }
  .session-action-btn.delete:hover {
    background: var(--red-subtle);
    color: var(--red);
  }
  .session-edit-input {
    width: 100%;
    background: var(--bg-void);
    border: 1px solid var(--accent);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: var(--font);
    padding: 4px 8px;
    outline: none;
  }
  .session-empty {
    padding: 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
