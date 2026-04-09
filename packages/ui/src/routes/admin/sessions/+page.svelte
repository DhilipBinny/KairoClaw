<script lang="ts">
  import { onMount } from 'svelte';
  import { getSessions, getSession, getSessionToolCalls, deleteSession, getDebugPrompt, getConfig, type ToolCallInfo } from '$lib/api';
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
    user_name?: string | null;
    user_id?: string | null;
  }

  interface SessionMessage {
    id: number;
    role: string;
    content: string;
    created_at: string;
  }

  interface UserGroup {
    id: string | null;
    name: string;
    sessionCount: number;
  }

  interface TimelineEntry {
    type: 'message' | 'tool_call';
    timestamp: string;
    message?: SessionMessage;
    toolCall?: ToolCallInfo;
  }

  let sessions: SessionRow[] = $state([]);
  let loading = $state(true);
  let searchQuery = $state('');
  let channelFilter = $state('all');
  let selectedUserId = $state<string | null | 'all'>('all');
  let confirmDeleteId = $state<string | null>(null);
  let confirmDeleteTimer: ReturnType<typeof setTimeout> | null = null;
  let selectedSession: string | null = $state(null);
  let selectedMessages: SessionMessage[] = $state([]);
  let timeline: TimelineEntry[] = $state([]);

  interface TurnGroup {
    number: number;
    entries: TimelineEntry[];
  }

  let turnGroups = $derived((): TurnGroup[] => {
    // Re-sort chronologically for grouping
    const sorted = [...timeline].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const groups: TimelineEntry[][] = [];
    let current: TimelineEntry[] = [];
    for (const entry of sorted) {
      if (entry.type === 'message' && entry.message?.role === 'user') {
        if (current.length > 0) groups.push(current);
        current = [entry];
      } else {
        current.push(entry);
      }
    }
    if (current.length > 0) groups.push(current);
    // Reverse for newest-first, assign turn numbers from original order
    return groups.reverse().map((entries, i, arr) => ({
      number: arr.length - i,
      entries,
    }));
  });
  let loadingMessages = $state(false);
  let deleteInProgress = $state('');
  let copyPromptState = $state<Record<number, 'idle' | 'loading' | 'copied' | 'error'>>({});
  let viewPromptData = $state<{ entries: any[]; turnNumber: number } | null>(null);
  let recordPromptEnabled = $state(false);

  type DebugEntry = {
    ts: string; model: string; turn: number; round: number;
    systemPrompt?: { cached?: string; dynamic?: string };
    messages?: { role: string; content: any }[];
    response?: { text?: string; toolCalls?: any[]; usage?: any; latencyMs?: number };
  };

  function formatEntriesToText(entries: DebugEntry[]): string {
    const parts: string[] = [];
    for (const e of entries) {
      parts.push(`${'═'.repeat(60)}`);
      parts.push(`Turn ${e.turn}  Round ${e.round}  Model: ${e.model}  ${e.ts}`);
      parts.push(`${'═'.repeat(60)}`);

      if (e.systemPrompt?.cached) {
        parts.push(`\n── SYSTEM PROMPT (cached) ──\n${e.systemPrompt.cached}`);
      }
      if (e.systemPrompt?.dynamic) {
        parts.push(`\n── SYSTEM PROMPT (dynamic) ──\n${e.systemPrompt.dynamic}`);
      }

      if (e.messages?.length) {
        parts.push(`\n── MESSAGES ──`);
        for (const m of e.messages) {
          const content = typeof m.content === 'string' ? m.content
            : Array.isArray(m.content) ? m.content.map((c: any) => c.text || `[${c.type}]`).join('\n')
            : JSON.stringify(m.content, null, 2);
          parts.push(`\n[${m.role.toUpperCase()}]\n${content}`);
        }
      }

      if (e.response) {
        parts.push(`\n── RESPONSE ──`);
        if (e.response.text) parts.push(e.response.text);
        if (e.response.toolCalls?.length) {
          parts.push(`\nTool calls: ${JSON.stringify(e.response.toolCalls, null, 2)}`);
        }
        if (e.response.usage) {
          const u = e.response.usage;
          parts.push(`\nTokens: in=${u.inputTokens} out=${u.outputTokens}  Latency: ${e.response.latencyMs}ms`);
        }
      }
    }
    return parts.join('\n');
  }

  async function fetchPromptData(messageId: number): Promise<DebugEntry[]> {
    if (!selectedSession) throw new Error('No session');
    const data = await getDebugPrompt(selectedSession, messageId);
    return data.entries as DebugEntry[];
  }

  async function copyPrompt(turnNumber: number, messageId: number) {
    if (!selectedSession) return;
    copyPromptState = { ...copyPromptState, [turnNumber]: 'loading' };
    try {
      const entries = await fetchPromptData(messageId);
      await navigator.clipboard.writeText(formatEntriesToText(entries));
      copyPromptState = { ...copyPromptState, [turnNumber]: 'copied' };
      setTimeout(() => { copyPromptState = { ...copyPromptState, [turnNumber]: 'idle' }; }, 2000);
    } catch (e: unknown) {
      copyPromptState = { ...copyPromptState, [turnNumber]: 'error' };
      setTimeout(() => { copyPromptState = { ...copyPromptState, [turnNumber]: 'idle' }; }, 3000);
    }
  }

  async function viewPrompt(turnNumber: number, messageId: number) {
    try {
      const entries = await fetchPromptData(messageId);
      viewPromptData = { entries, turnNumber };
      activeRound = entries.length - 1; // default to last round
    } catch { /* not recorded */ }
  }

  let copiedSection = $state<string | null>(null);
  async function copySection(key: string, text: string) {
    await navigator.clipboard.writeText(text);
    copiedSection = key;
    setTimeout(() => { copiedSection = null; }, 2000);
  }

  let activeRound = $state(0); // index into viewPromptData.entries

  let channels = $derived([...new Set(sessions.map(s => s.channel))].sort());

  // Group sessions by user
  let userGroups = $derived((): UserGroup[] => {
    const map = new Map<string | null, { name: string; count: number }>();
    for (const s of sessions) {
      const key = s.user_id ?? null;
      const existing = map.get(key);
      if (existing) {
        existing.count++;
      } else {
        map.set(key, { name: s.user_name || 'Unlinked', count: 1 });
      }
    }
    const groups: UserGroup[] = [];
    for (const [id, { name, count }] of map) {
      groups.push({ id, name, sessionCount: count });
    }
    // Sort: named users first (alphabetical), then unlinked last
    groups.sort((a, b) => {
      if (a.id === null) return 1;
      if (b.id === null) return -1;
      return a.name.localeCompare(b.name);
    });
    return groups;
  });

  let filteredSessions = $derived(
    sessions.filter((s) => {
      // User filter
      if (selectedUserId !== 'all') {
        if (selectedUserId === null && s.user_id !== null) return false;
        if (selectedUserId !== null && s.user_id !== selectedUserId) return false;
      }
      if (channelFilter !== 'all' && s.channel !== channelFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return s.id.toLowerCase().includes(q) || s.channel.toLowerCase().includes(q) || (s.title || '').toLowerCase().includes(q) || (s.user_name || '').toLowerCase().includes(q);
      }
      return true;
    })
  );

  async function loadSessions() {
    loading = true;
    try {
      const data = await getSessions(200);
      sessions = data.sessions;
    } catch (e) {
      console.error('Failed to load sessions:', e);
    } finally {
      loading = false;
    }
  }

  function formatJson(json: string): string {
    try { return JSON.stringify(JSON.parse(json), null, 2); } catch { return json; }
  }

  async function viewSession(id: string) {
    selectedSession = id;
    loadingMessages = true;
    try {
      const [msgData, tcData] = await Promise.all([
        getSession(id),
        getSessionToolCalls(id).catch(() => ({ toolCalls: [] })),
      ]);
      selectedMessages = msgData.messages;

      // Build interleaved timeline
      const entries: TimelineEntry[] = [];
      for (const msg of msgData.messages) {
        entries.push({ type: 'message', timestamp: msg.created_at, message: msg });
      }
      for (const tc of tcData.toolCalls) {
        entries.push({ type: 'tool_call', timestamp: tc.created_at, toolCall: tc });
      }
      entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      timeline = entries;
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
      case 'whatsapp': return 'green';
      case 'api': return 'yellow';
      default: return 'default';
    }
  }

  function selectUser(userId: string | null | 'all') {
    selectedUserId = userId;
    selectedSession = null;
    selectedMessages = [];
  }

  onMount(async () => {
    loadSessions();
    try {
      const { config } = await getConfig();
      recordPromptEnabled = (config as any)?.agent?.debug?.recordPrompt === true;
    } catch { /* ignore */ }
  });
</script>

<svelte:head>
  <title>Sessions - Admin - Kairo</title>
</svelte:head>

<div class="sessions-page">
  <div class="page-header">
    <h1 class="page-title">Sessions</h1>
    <p class="page-desc">Browse and manage chat sessions grouped by user.</p>
  </div>

  <div class="sessions-layout">
    <!-- User sidebar -->
    <div class="users-panel">
      <h3 class="panel-title">Users</h3>
      <button
        class="user-row"
        class:active={selectedUserId === 'all'}
        onclick={() => selectUser('all')}
      >
        <span class="user-name">All Users</span>
        <span class="user-count">{sessions.length}</span>
      </button>
      {#each userGroups() as group}
        <button
          class="user-row"
          class:active={selectedUserId === group.id}
          onclick={() => selectUser(group.id)}
        >
          <span class="user-name">{group.name}</span>
          <span class="user-count">{group.sessionCount}</span>
        </button>
      {/each}
    </div>

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
          {searchQuery ? 'No sessions match your search.' : 'No sessions for this user.'}
        </div>
      {:else}
        <div class="sessions-list">
          {#each filteredSessions as session (session.id)}
            <button
              class="session-row"
              class:active={selectedSession === session.id}
              onclick={() => viewSession(session.id)}
            >
              <div class="session-row-header">
                <Badge variant={channelVariant(session.channel)}>{session.channel}</Badge>
                {#if selectedUserId === 'all' && session.user_name}
                  <span class="session-user">{session.user_name}</span>
                {/if}
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
            {#each turnGroups() as turn (turn.number)}
              <div class="turn-group">
                <div class="turn-label">
                  <span>Turn {turn.number}</span>
                  {#if recordPromptEnabled}
                  <button
                    class="copy-prompt-btn"
                    onclick={() => viewPrompt(turn.number, turn.entries[0].message!.id)}
                    title="View full LLM request in a readable panel"
                  >View</button>
                  <button
                    class="copy-prompt-btn"
                    class:loading={copyPromptState[turn.number] === 'loading'}
                    class:copied={copyPromptState[turn.number] === 'copied'}
                    class:error={copyPromptState[turn.number] === 'error'}
                    onclick={() => copyPrompt(turn.number, turn.entries[0].message!.id)}
                    title="Copy full LLM request as formatted text to clipboard"
                    disabled={copyPromptState[turn.number] === 'loading'}
                  >
                    {#if copyPromptState[turn.number] === 'loading'}
                      Copying...
                    {:else if copyPromptState[turn.number] === 'copied'}
                      ✓ Copied
                    {:else if copyPromptState[turn.number] === 'error'}
                      Not recorded
                    {:else}
                      Copy
                    {/if}
                  </button>
                  {/if}
                </div>
                {#each turn.entries as entry}
                  {#if entry.type === 'message' && entry.message}
                    <div class="message-row" class:user={entry.message.role === 'user'} class:assistant={entry.message.role === 'assistant'} class:system={entry.message.role === 'system'}>
                      <div class="message-role">
                        <Badge variant={entry.message.role === 'user' ? 'blue' : entry.message.role === 'system' ? 'yellow' : 'green'}>{entry.message.role}</Badge>
                      </div>
                      <div class="message-content">{entry.message.content?.slice(0, 2000) || ''}{(entry.message.content?.length ?? 0) > 2000 ? '...' : ''}</div>
                    </div>
                  {:else if entry.type === 'tool_call' && entry.toolCall}
                    <div class="tool-call-row" class:error={entry.toolCall.status === 'error'}>
                      <div class="tool-call-header">
                        <Badge variant={entry.toolCall.status === 'error' ? 'red' : entry.toolCall.status === 'denied' ? 'yellow' : 'default'}>
                          {entry.toolCall.tool_name}
                        </Badge>
                        {#if entry.toolCall.duration_ms}
                          <span class="tool-duration">{entry.toolCall.duration_ms}ms</span>
                        {/if}
                        <span class="tool-status" class:success={entry.toolCall.status === 'success'} class:err={entry.toolCall.status === 'error'}>{entry.toolCall.status}</span>
                      </div>
                      <details class="tool-details">
                        <summary>Arguments</summary>
                        <pre class="tool-json">{formatJson(entry.toolCall.arguments)}</pre>
                      </details>
                      {#if entry.toolCall.result}
                        <details class="tool-details">
                          <summary>Result</summary>
                          <pre class="tool-json">{formatJson(entry.toolCall.result)}</pre>
                        </details>
                      {/if}
                    </div>
                  {/if}
                {/each}
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

{#if viewPromptData}
  <div class="prompt-modal-overlay" onclick={() => viewPromptData = null} role="presentation">
    <div class="prompt-modal" onclick={(e) => e.stopPropagation()} role="dialog">
      <div class="prompt-modal-header">
        <span>Turn {viewPromptData.turnNumber} — LLM Request</span>
        <button class="prompt-modal-close" onclick={() => viewPromptData = null}>✕</button>
      </div>
      <!-- Round tabs (only show if more than 1 round) -->
      {#if viewPromptData.entries.length > 1}
        <div class="prompt-tabs">
          {#each viewPromptData.entries as entry, i}
            <button class="prompt-tab" class:active={activeRound === i} onclick={() => activeRound = i}>
              Round {entry.round}
              <span class="prompt-tab-meta">{new Date(entry.ts).toLocaleTimeString()}</span>
            </button>
          {/each}
        </div>
      {/if}

      <div class="prompt-modal-body">
        {#each viewPromptData.entries as entry, i}
          {#if i === activeRound}
            <div class="prompt-section-meta">{entry.model}</div>

            {#if entry.systemPrompt?.cached}
              {@const key = `${i}-cached`}
              <details class="prompt-section" open>
                <summary class="prompt-section-title">
                  System Prompt (cached)
                  <button class="prompt-copy-icon" class:ok={copiedSection === key}
                    onclick={(e) => { e.stopPropagation(); copySection(key, entry.systemPrompt!.cached!); }}
                    title="Copy to clipboard">{copiedSection === key ? '✓' : '⎘'}</button>
                </summary>
                <pre class="prompt-pre">{entry.systemPrompt.cached}</pre>
              </details>
            {/if}
            {#if entry.systemPrompt?.dynamic}
              {@const key = `${i}-dynamic`}
              <details class="prompt-section" open>
                <summary class="prompt-section-title">
                  System Prompt (dynamic)
                  <button class="prompt-copy-icon" class:ok={copiedSection === key}
                    onclick={(e) => { e.stopPropagation(); copySection(key, entry.systemPrompt!.dynamic!); }}
                    title="Copy to clipboard">{copiedSection === key ? '✓' : '⎘'}</button>
                </summary>
                <pre class="prompt-pre">{entry.systemPrompt.dynamic}</pre>
              </details>
            {/if}

            {#if entry.messages?.length}
              {@const key = `${i}-messages`}
              {@const msgsText = entry.messages.map((m: any) => {
                const content = typeof m.content === 'string' ? m.content
                  : Array.isArray(m.content) ? m.content.map((c: any) => c.text || `[${c.type}]`).join('\n')
                  : JSON.stringify(m.content, null, 2);
                return `[${m.role.toUpperCase()}]\n${content}`;
              }).join('\n─────────────────────────\n')}
              <details class="prompt-section" open>
                <summary class="prompt-section-title">
                  Messages ({entry.messages.length})
                  <button class="prompt-copy-icon" class:ok={copiedSection === key}
                    onclick={(e) => { e.stopPropagation(); copySection(key, msgsText); }}
                    title="Copy to clipboard">{copiedSection === key ? '✓' : '⎘'}</button>
                </summary>
                <pre class="prompt-pre">{msgsText}</pre>
              </details>
            {/if}

            {#if entry.response}
              {@const key = `${i}-response`}
              {@const respText = [
                entry.response.text || '',
                entry.response.toolCalls?.length ? `\nTool calls:\n${JSON.stringify(entry.response.toolCalls, null, 2)}` : ''
              ].filter(Boolean).join('\n')}
              <details class="prompt-section" open>
                <summary class="prompt-section-title">
                  Response{entry.response.usage ? ` · in ${entry.response.usage.inputTokens} · out ${entry.response.usage.outputTokens} · ${entry.response.latencyMs}ms` : ''}
                  <button class="prompt-copy-icon" class:ok={copiedSection === key}
                    onclick={(e) => { e.stopPropagation(); copySection(key, respText); }}
                    title="Copy to clipboard">{copiedSection === key ? '✓' : '⎘'}</button>
                </summary>
                <pre class="prompt-pre">{respText}</pre>
              </details>
            {/if}
          {/if}
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .sessions-page {
    height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
  }
  .page-header { margin-bottom: 16px; }
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.3px; }
  .page-desc { color: var(--text-muted); font-size: 14px; }

  .sessions-layout {
    flex: 1;
    display: flex;
    gap: 12px;
    min-height: 0;
  }

  /* Users panel */
  .users-panel {
    width: 180px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
  }
  .panel-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    padding: 0 8px 8px;
  }
  .user-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    text-align: left;
    padding: 8px 12px;
    border-radius: var(--radius);
    border: 1px solid transparent;
    background: none;
    cursor: pointer;
    font-family: var(--font);
    font-size: 13px;
    color: var(--text-secondary);
    transition: all var(--duration) var(--ease);
  }
  .user-row:hover { background: var(--bg-raised); color: var(--text-primary); }
  .user-row.active { background: var(--accent-subtle); border-color: var(--border-accent); color: var(--accent); font-weight: 600; }
  .user-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .user-count {
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-raised);
    padding: 1px 6px;
    border-radius: 8px;
    flex-shrink: 0;
  }

  /* Sessions list panel */
  .sessions-list-panel {
    width: 300px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
  }
  .search-bar {
    margin-bottom: 10px;
    display: flex;
    gap: 6px;
    align-items: center;
    position: relative;
  }
  .search-icon {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }
  .search-input {
    padding-left: 32px;
    flex: 1;
    min-width: 0;
    font-size: 12px;
  }
  .channel-filter {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: 12px;
    padding: 6px 8px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .sessions-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .session-row {
    display: block;
    width: 100%;
    text-align: left;
    padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid var(--border-subtle);
    background: var(--bg-surface);
    cursor: pointer;
    font-family: var(--font);
    color: var(--text-primary);
    transition: all var(--duration) var(--ease);
  }
  .session-row:hover { background: var(--bg-raised); }
  .session-row.active { border-color: var(--border-accent); background: var(--accent-subtle); }
  .session-row-header { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
  .session-user { font-size: 11px; font-weight: 600; color: var(--accent); }
  .session-turns { font-size: 11px; color: var(--text-muted); margin-left: auto; }
  .session-title-text { font-size: 12px; color: var(--text-primary); margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session-date { font-size: 11px; color: var(--text-muted); }

  /* Messages panel */
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
    padding: 12px 18px;
    border-bottom: 1px solid var(--border);
  }
  .messages-header-info { display: flex; align-items: center; gap: 10px; }
  .messages-header-info h3 { font-size: 14px; font-weight: 600; }
  .messages-session-id {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    background: var(--bg-raised);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
  }
  .messages-list {
    flex: 1;
    overflow-y: scroll;
    padding: 12px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .messages-list::-webkit-scrollbar { width: 6px; }
  .messages-list::-webkit-scrollbar-track { background: transparent; }
  .messages-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  .messages-list::-webkit-scrollbar-thumb:hover { background: var(--text-ghost); }

  /* Turn grouping */
  .turn-group {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    margin-bottom: 12px;
  }
  .turn-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-ghost);
    padding: 5px 8px 5px 12px;
    background: var(--bg-raised);
    border-bottom: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .copy-prompt-btn {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-muted);
    cursor: pointer;
    transition: all var(--duration) var(--ease);
  }
  .copy-prompt-btn:hover { color: var(--accent); border-color: var(--border-accent); background: var(--accent-subtle); }
  .copy-prompt-btn.copied { color: var(--green, #22c55e); border-color: var(--green, #22c55e); }
  .copy-prompt-btn.error { color: var(--text-muted); border-style: dashed; cursor: default; }
  .copy-prompt-btn.loading { opacity: 0.6; cursor: default; }
  .copy-prompt-btn:disabled { cursor: default; }

  .message-row { padding: 12px 14px; border-top: 1px solid var(--border-subtle); }
  .message-row:first-of-type { border-top: none; }
  .message-row.user { background: var(--bg-void); }
  .message-row.assistant { background: var(--bg-raised); }
  .message-role { margin-bottom: 6px; }
  .message-content { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .message-row.system { background: var(--bg-surface); border-left: 3px solid var(--text-ghost); }

  /* Tool call rows */
  .tool-call-row {
    padding: 8px 14px;
    border-top: 1px solid var(--border-subtle);
    background: var(--bg-surface);
    border-left: 3px solid var(--accent);
    font-size: 12px;
  }
  .tool-call-row.error { border-left-color: var(--red, #ef4444); }
  .tool-call-header { display: flex; align-items: center; gap: 8px; }
  .tool-duration { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }
  .tool-status { font-size: 11px; color: var(--text-muted); margin-left: auto; }
  .tool-status.success { color: var(--green, #22c55e); }
  .tool-status.err { color: var(--red, #ef4444); }
  .tool-details { margin-top: 6px; }
  .tool-details summary {
    font-size: 11px;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
  }
  .tool-details summary:hover { color: var(--text-secondary); }
  .tool-json {
    font-size: 11px;
    font-family: var(--font-mono);
    background: var(--bg-void);
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    overflow-x: auto;
    max-height: 300px;
    overflow-y: auto;
    margin-top: 4px;
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
    .sessions-layout { flex-direction: column; }
    .users-panel {
      width: 100%;
      flex-direction: row;
      overflow-x: auto;
      gap: 4px;
      padding-bottom: 8px;
    }
    .panel-title { display: none; }
    .user-row { white-space: nowrap; padding: 6px 10px; font-size: 12px; }
    .sessions-list-panel { width: 100%; max-height: 35vh; }
    .messages-panel { min-height: 300px; }
    .messages-header { padding: 10px 14px; flex-wrap: wrap; gap: 8px; }
    .session-row { padding: 8px 10px; }
  }

  /* Prompt viewer modal */
  .prompt-modal-overlay {
    position: fixed; inset: 0; z-index: 100;
    background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .prompt-modal {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    width: 100%; max-width: 900px;
    max-height: 90vh;
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .prompt-modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px; font-weight: 600;
    flex-shrink: 0;
  }
  .prompt-modal-close {
    background: none; border: none; cursor: pointer;
    color: var(--text-muted); font-size: 14px; padding: 2px 6px;
  }
  .prompt-modal-close:hover { color: var(--text-primary); }
  .prompt-modal-body {
    flex: 1; min-height: 0;
    overflow-y: auto; padding: 16px;
    display: flex; flex-direction: column; gap: 12px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .prompt-tabs {
    display: flex; gap: 2px;
    padding: 8px 16px 0;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
    overflow-x: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .prompt-tab {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 14px;
    font-size: 12px; font-weight: 600;
    background: none; border: none; cursor: pointer;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    transition: color 0.15s;
  }
  .prompt-tab:hover { color: var(--text-primary); }
  .prompt-tab.active { color: var(--accent); border-bottom-color: var(--accent); background: var(--bg-raised); }
  .prompt-tab-meta { font-size: 10px; font-weight: 400; color: var(--text-muted); font-family: var(--font-mono); }
  .prompt-section { border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); overflow: hidden; }
  .prompt-section-title {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.5px; color: var(--text-muted);
    padding: 6px 10px; cursor: pointer;
    background: var(--bg-surface);
    user-select: none;
  }
  .prompt-section-title:hover { color: var(--text-secondary); }
  .prompt-section-title { display: flex; align-items: center; justify-content: space-between; }
  .prompt-copy-icon {
    background: none; border: none; cursor: pointer;
    font-size: 13px; color: var(--text-muted); padding: 0 4px;
    line-height: 1; flex-shrink: 0;
  }
  .prompt-copy-icon:hover { color: var(--accent); }
  .prompt-copy-icon.ok { color: var(--green, #22c55e); }
  .prompt-pre {
    font-size: 12px; font-family: var(--font-mono);
    white-space: pre-wrap; word-break: break-word;
    padding: 10px 12px; margin: 0;
    background: var(--bg-void);
    line-height: 1.6;
    max-height: 300px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .prompt-pre-secondary { font-size: 11px; color: var(--text-muted); }
  .prompt-messages-list {
    max-height: 400px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .prompt-msg { border-top: 1px solid var(--border-subtle); }
  .prompt-msg-user .prompt-pre { background: var(--bg-void); }
  .prompt-msg-assistant .prompt-pre { background: var(--bg-raised); }
  .prompt-msg-role {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; padding: 4px 12px;
    color: var(--text-muted); background: var(--bg-surface);
  }
  .prompt-usage {
    font-size: 11px; color: var(--text-muted);
    font-family: var(--font-mono); padding: 6px 12px;
    background: var(--bg-surface);
  }
</style>
