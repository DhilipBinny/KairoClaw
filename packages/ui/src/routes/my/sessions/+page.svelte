<script lang="ts">
  import { onMount } from 'svelte';
  import { getSessions, getSession, deleteSession } from '$lib/api';
  import Badge from '$lib/components/Badge.svelte';

  interface SessionRow {
    id: string;
    channel: string;
    title?: string;
    turns: number;
    created_at: string;
    updated_at: string;
  }

  let sessions: SessionRow[] = $state([]);
  let loading = $state(true);
  let selectedSession: string | null = $state(null);
  let messages: Array<{ role: string; content: string; created_at: string }> = $state([]);
  let loadingMessages = $state(false);

  async function loadSessions() {
    loading = true;
    try {
      const data = await getSessions();
      sessions = (data as { sessions: SessionRow[] }).sessions || [];
    } catch { /* ignore */ }
    finally { loading = false; }
  }

  async function viewSession(id: string) {
    selectedSession = id;
    loadingMessages = true;
    try {
      const data = await getSession(id);
      messages = (data as { messages: typeof messages }).messages || [];
    } catch { messages = []; }
    finally { loadingMessages = false; }
  }

  onMount(loadSessions);
</script>

<svelte:head><title>My Sessions - Kairo</title></svelte:head>

<h1 class="page-title">My Sessions</h1>

{#if loading}
  <span class="spinner"></span>
{:else if sessions.length === 0}
  <p class="empty">No sessions yet. Start chatting to create one.</p>
{:else}
  <div class="sessions-layout">
    <div class="session-list">
      {#each sessions as s (s.id)}
        <button class="session-row" class:active={selectedSession === s.id} onclick={() => viewSession(s.id)}>
          <div class="session-header">
            <Badge variant={s.channel === 'telegram' ? 'blue' : s.channel === 'whatsapp' ? 'green' : 'default'}>{s.channel}</Badge>
            <span class="session-turns">{s.turns} turns</span>
          </div>
          <div class="session-title">{s.title || s.id.slice(0, 20) + '...'}</div>
          <div class="session-date">{new Date(s.updated_at || s.created_at).toLocaleDateString()}</div>
        </button>
      {/each}
    </div>
    <div class="session-detail">
      {#if selectedSession}
        {#if loadingMessages}
          <span class="spinner"></span>
        {:else}
          <div class="messages">
            {#each messages as m}
              <div class="msg" class:user={m.role === 'user'} class:assistant={m.role === 'assistant'}>
                <span class="msg-role">{m.role}</span>
                <div class="msg-content">{m.content}</div>
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        <p class="empty">Select a session to view messages.</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 16px; }
  .empty { color: var(--text-muted); }
  .sessions-layout { display: flex; gap: 20px; height: calc(100vh - 120px); }
  .sessions-layout { display: flex; gap: 20px; height: calc(100dvh - 120px); }
  .session-list { width: 300px; min-width: 250px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
  .session-row {
    text-align: left; width: 100%; padding: 10px 12px; border: 1px solid var(--border-subtle);
    border-radius: var(--radius); background: var(--bg-surface); cursor: pointer;
  }
  .session-row:hover { background: var(--bg-raised); }
  .session-row.active { border-color: var(--accent); background: var(--bg-raised); }
  .session-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .session-turns { font-size: 11px; color: var(--text-muted); margin-left: auto; }
  .session-title { font-size: 13px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .session-date { font-size: 11px; color: var(--text-muted); }
  .session-detail { flex: 1; overflow-y: auto; }
  .messages { display: flex; flex-direction: column; gap: 12px; }
  .msg { padding: 10px 14px; border-radius: var(--radius); background: var(--bg-surface); border: 1px solid var(--border-subtle); }
  .msg.user { border-left: 3px solid var(--accent); }
  .msg.assistant { border-left: 3px solid var(--green); }
  .msg-role { font-size: 10px; font-weight: 600; text-transform: uppercase; color: var(--text-muted); }
  .msg-content { font-size: 13px; margin-top: 4px; white-space: pre-wrap; color: var(--text-primary); }

  @media (max-width: 768px) {
    .sessions-layout { flex-direction: column; height: auto; }
    .session-list { width: 100%; min-width: unset; max-height: 40vh; }
    .session-detail { min-height: 40vh; }
  }
</style>
