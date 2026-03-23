<script lang="ts">
  import { onMount } from 'svelte';
  import { getSessions, getSession, deleteSession } from '$lib/api';
  import Badge from '$lib/components/Badge.svelte';

  interface SessionRow {
    id: string;
    channel: string;
    title?: string;
    turns: number;
    input_tokens: number;
    output_tokens: number;
    created_at: string;
    updated_at: string;
  }

  interface SessionMessage {
    role: string;
    content: string;
    created_at: string;
  }

  let sessions: SessionRow[] = $state([]);
  let loading = $state(true);
  let searchQuery = $state('');
  let channelFilter = $state('all');
  let confirmDeleteId = $state<string | null>(null);
  let confirmDeleteTimer: ReturnType<typeof setTimeout> | null = null;
  let selectedSession: string | null = $state(null);
  let selectedMessages: SessionMessage[] = $state([]);
  let loadingMessages = $state(false);
  let deleteInProgress = $state('');

  let channels = $derived([...new Set(sessions.map(s => s.channel))].sort());

  let filteredSessions = $derived(
    sessions.filter((s) => {
      if (channelFilter !== 'all' && s.channel !== channelFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return s.id.toLowerCase().includes(q) || s.channel.toLowerCase().includes(q) || (s.title || '').toLowerCase().includes(q);
      }
      return true;
    })
  );

  async function loadSessions() {
    loading = true;
    try {
      const data = await getSessions(100);
      sessions = data.sessions;
    } catch (e) {
      console.error('Failed to load sessions:', e);
    } finally {
      loading = false;
    }
  }

  async function viewSession(id: string) {
    selectedSession = id;
    loadingMessages = true;
    try {
      const data = await getSession(id);
      selectedMessages = data.messages;
    } catch (e) {
      console.error('Failed to load session:', e);
    } finally {
      loadingMessages = false;
    }
  }

  function requestDeleteSession(id: string) {
    if (confirmDeleteId === id) {
      performDeleteSession(id);
      return;
    }
    confirmDeleteId = id;
    if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer);
    confirmDeleteTimer = setTimeout(() => { confirmDeleteId = null; }, 3000);
  }

  async function performDeleteSession(id: string) {
    confirmDeleteId = null;
    if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer);
    deleteInProgress = id;
    try {
      await deleteSession(id);
      sessions = sessions.filter((s) => s.id !== id);
      if (selectedSession === id) {
        selectedSession = null;
        selectedMessages = [];
      }
    } catch (e) {
      console.error('Failed to delete session:', e);
    } finally {
      deleteInProgress = '';
    }
  }

  function channelVariant(channel: string): 'blue' | 'green' | 'yellow' | 'default' {
    switch (channel) {
      case 'web': return 'blue';
      case 'telegram': return 'green';
      case 'api': return 'yellow';
      default: return 'default';
    }
  }

  onMount(loadSessions);
</script>

<svelte:head>
  <title>Sessions - Admin - Kairo</title>
</svelte:head>

<div class="sessions-page">
  <div class="page-header">
    <h1 class="page-title">Sessions</h1>
    <p class="page-desc">Browse and manage chat sessions.</p>
  </div>

  <div class="sessions-layout">
    <!-- Session list -->
    <div class="sessions-list-panel">
      <div class="search-bar">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          class="input search-input"
          type="text"
          placeholder="Search sessions..."
          bind:value={searchQuery}
        />
        <select class="channel-filter" bind:value={channelFilter}>
          <option value="all">All channels</option>
          {#each channels as ch}
            <option value={ch}>{ch}</option>
          {/each}
        </select>
      </div>

      {#if loading}
        <div class="loading"><span class="spinner"></span> Loading...</div>
      {:else if filteredSessions.length === 0}
        <div class="empty">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-ghost)">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          {searchQuery ? 'No sessions match your search.' : 'No sessions found. Start a conversation to see sessions here.'}
        </div>
      {:else}
        <div class="sessions-list">
          {#each filteredSessions as session (session.id)}
            <button
              class="session-row"
              class:active={selectedSession === session.id}
              aria-label="View session {session.id.slice(0, 16)}"
              onclick={() => viewSession(session.id)}
            >
              <div class="session-row-header">
                <Badge variant={channelVariant(session.channel)}>{session.channel}</Badge>
                <span class="session-turns">{session.turns} turns</span>
              </div>
              <div class="session-title-text" title={session.id}>{session.title || session.id.slice(0, 24) + '...'}</div>
              <div class="session-date">
                {new Date(session.updated_at || session.created_at).toLocaleString()}
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Message viewer -->
    <div class="messages-panel">
      {#if selectedSession}
        <div class="messages-header">
          <div class="messages-header-info">
            <h3>Session</h3>
            <code class="messages-session-id" title={selectedSession}>{selectedSession.slice(0, 24)}...</code>
          </div>
          <button
            class="btn btn-sm btn-danger"
            aria-label={confirmDeleteId === selectedSession ? 'Confirm delete session' : 'Delete session'}
            onclick={() => requestDeleteSession(selectedSession!)}
            disabled={deleteInProgress === selectedSession}
          >
            {deleteInProgress === selectedSession ? 'Deleting...' : confirmDeleteId === selectedSession ? 'Confirm?' : 'Delete'}
          </button>
        </div>

        {#if loadingMessages}
          <div class="loading"><span class="spinner"></span> Loading messages...</div>
        {:else}
          <div class="messages-list">
            {#each selectedMessages as msg, i}
              <div class="message-row" class:user={msg.role === 'user'} class:assistant={msg.role === 'assistant'}>
                <div class="message-role">
                  <Badge variant={msg.role === 'user' ? 'blue' : 'green'}>{msg.role}</Badge>
                </div>
                <div class="message-content">{msg.content?.slice(0, 2000) || ''}{msg.content?.length > 2000 ? '...' : ''}</div>
              </div>
            {:else}
              <div class="empty">No messages in this session</div>
            {/each}
          </div>
        {/if}
      {:else}
        <div class="no-selection">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-ghost)">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          <span>Select a session to view messages</span>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .sessions-page {
    height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
  }
  .page-header {
    margin-bottom: 16px;
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
  .sessions-layout {
    flex: 1;
    display: flex;
    gap: 16px;
    min-height: 0;
  }
  .sessions-list-panel {
    width: 340px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
  }
  .search-bar {
    margin-bottom: 12px;
    display: flex;
    gap: 8px;
    align-items: center;
    position: relative;
  }
  .search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }
  .search-input {
    padding-left: 36px;
    flex: 1;
    min-width: 0;
  }
  .channel-filter {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: 13px;
    padding: 7px 10px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .channel-filter:focus {
    outline: none;
    border-color: var(--accent);
  }
  .sessions-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .session-row {
    display: block;
    width: 100%;
    text-align: left;
    padding: 12px 14px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    cursor: pointer;
    font-family: var(--font);
    color: var(--text-primary);
    transition: all var(--duration) var(--ease);
  }
  .session-row:hover {
    border-color: var(--border);
    background: var(--bg-raised);
  }
  .session-row.active {
    border-color: var(--border-accent);
    background: var(--accent-subtle);
  }
  .session-row-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .session-turns {
    font-size: 11px;
    color: var(--text-muted);
  }
  .session-title-text {
    font-size: 12px;
    color: var(--text-primary);
    margin-bottom: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-date {
    font-size: 11px;
    color: var(--text-muted);
  }
  .messages-panel {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .messages-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
  }
  .messages-header-info {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .messages-header-info h3 {
    font-size: 14px;
    font-weight: 600;
  }
  .messages-session-id {
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    background: var(--bg-raised);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
  }
  .messages-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }
  .message-row {
    padding: 12px 14px;
    margin-bottom: 8px;
    border-radius: var(--radius);
    transition: background var(--duration) var(--ease);
  }
  .message-row.user { background: var(--bg-void); }
  .message-row.assistant { background: var(--bg-raised); }
  .message-role {
    margin-bottom: 6px;
  }
  .message-content {
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .loading, .empty, .no-selection {
    padding: 40px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }

  @media (max-width: 768px) {
    .page-title { font-size: 20px; }
    .page-desc { font-size: 13px; }
    .sessions-layout {
      flex-direction: column;
    }
    .sessions-list-panel {
      width: 100%;
      max-height: 40vh;
      flex-shrink: 0;
    }
    .messages-panel {
      min-height: 300px;
    }
    .messages-header {
      padding: 10px 14px;
      flex-wrap: wrap;
      gap: 8px;
    }
    .messages-session-id { font-size: 11px; }
    .session-row { padding: 10px 12px; }
  }
</style>
