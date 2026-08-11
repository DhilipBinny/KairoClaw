<script lang="ts">
  import { onMount } from 'svelte';
  import { getSessions, getSession, getSessionToolCalls, deleteSession, getDebugPrompt, getConfig, type ToolCallInfo } from '$lib/api';
  import Badge from '$lib/components/Badge.svelte';
  import AuthImage from '$lib/components/AuthImage.svelte';

  interface SessionRow {
    id: string;
    channel: string;
    title?: string;
    turns: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd?: number;
    created_at: string;
    updated_at: string;
    user_name?: string | null;
    user_id?: string | null;
  }

  interface SessionMessage {
    id?: number;
    role: string;
    content: string;
    created_at: string;
    metadata?: string;
  }

  function getImageFilenames(metadata?: string): string[] {
    if (!metadata) return [];
    try {
      const parsed = JSON.parse(metadata);
      if (Array.isArray(parsed.images)) return parsed.images as string[];
    } catch { /* ignore */ }
    return [];
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
  let sessionSort = $state<'recent' | 'cost' | 'turns'>('recent');
  let selectedSession: string | null = $state(null);
  let selectedMessages: SessionMessage[] = $state([]);
  let timeline: TimelineEntry[] = $state([]);
  let loadingMessages = $state(false);
  let deleteInProgress = $state('');

  // ── Debug-prompt viewer state ───────────────────────────
  let copyPromptState = $state<Record<number, 'idle' | 'loading' | 'copied' | 'error'>>({});
  let viewPromptData = $state<{ entries: DebugEntry[]; turnLabel: string } | null>(null);
  let recordPromptEnabled = $state(false);
  let activeRound = $state(0);
  let copiedSection = $state<string | null>(null);

  type DebugEntry = {
    ts: string; model: string; turn: number; round: number;
    systemPrompt?: { cached?: string; dynamic?: string };
    messages?: { role: string; content: unknown }[];
    response?: { text?: string; toolCalls?: unknown[]; usage?: { inputTokens?: number; outputTokens?: number }; latencyMs?: number };
  };

  function formatEntriesToText(entries: DebugEntry[]): string {
    const parts: string[] = [];
    for (const e of entries) {
      parts.push('═'.repeat(60));
      parts.push(`Turn ${e.turn}  Round ${e.round}  Model: ${e.model}  ${e.ts}`);
      parts.push('═'.repeat(60));

      if (e.systemPrompt?.cached) {
        parts.push(`\n── SYSTEM PROMPT (cached) ──\n${e.systemPrompt.cached}`);
      }
      if (e.systemPrompt?.dynamic) {
        parts.push(`\n── SYSTEM PROMPT (dynamic) ──\n${e.systemPrompt.dynamic}`);
      }

      if (e.messages?.length) {
        parts.push('\n── MESSAGES ──');
        for (const m of e.messages) {
          const c = m.content;
          const content = typeof c === 'string' ? c
            : Array.isArray(c) ? c.map((p: { text?: string; type?: string }) => p.text || `[${p.type}]`).join('\n')
            : JSON.stringify(c, null, 2);
          parts.push(`\n[${m.role.toUpperCase()}]\n${content}`);
        }
      }

      if (e.response) {
        parts.push('\n── RESPONSE ──');
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

  async function copyPrompt(messageId: number) {
    if (!selectedSession) return;
    copyPromptState = { ...copyPromptState, [messageId]: 'loading' };
    try {
      const entries = await fetchPromptData(messageId);
      await navigator.clipboard.writeText(formatEntriesToText(entries));
      copyPromptState = { ...copyPromptState, [messageId]: 'copied' };
      setTimeout(() => { copyPromptState = { ...copyPromptState, [messageId]: 'idle' }; }, 2000);
    } catch {
      copyPromptState = { ...copyPromptState, [messageId]: 'error' };
      setTimeout(() => { copyPromptState = { ...copyPromptState, [messageId]: 'idle' }; }, 3000);
    }
  }

  async function viewPrompt(messageId: number, label: string) {
    try {
      const entries = await fetchPromptData(messageId);
      viewPromptData = { entries, turnLabel: label };
      activeRound = entries.length - 1;
    } catch { /* not recorded — likely off when this turn ran */ }
  }

  async function copySection(key: string, text: string) {
    await navigator.clipboard.writeText(text);
    copiedSection = key;
    setTimeout(() => { copiedSection = null; }, 2000);
  }

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

  let filteredSessions = $derived.by((): SessionRow[] => {
    const filtered = sessions.filter((s) => {
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
    });
    const sorted = [...filtered];
    if (sessionSort === 'cost') {
      sorted.sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0));
    } else if (sessionSort === 'turns') {
      sorted.sort((a, b) => b.turns - a.turns);
    }
    return sorted;
  });

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
      entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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
      const cfg = config as { agent?: { debug?: { recordPrompt?: boolean } } };
      recordPromptEnabled = cfg?.agent?.debug?.recordPrompt === true;
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
        <select class="channel-filter" bind:value={sessionSort}>
          <option value="recent">Recent</option>
          <option value="cost">Cost</option>
          <option value="turns">Turns</option>
        </select>
      </div>
      {#if !loading && sessions.length > 0}
        <div class="session-count">{filteredSessions.length} of {sessions.length} sessions{sessions.length >= 200 ? ' (limit reached)' : ''}</div>
      {/if}

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
                {#if session.cost_usd && session.cost_usd > 0.001}
                  <span class="session-cost">${session.cost_usd.toFixed(2)}</span>
                {/if}
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
            {#each timeline as entry}
              {#if entry.type === 'message' && entry.message}
                <div class="message-row" class:user={entry.message.role === 'user'} class:assistant={entry.message.role === 'assistant'} class:system={entry.message.role === 'system'}>
                  <div class="message-role">
                    <Badge variant={entry.message.role === 'user' ? 'blue' : entry.message.role === 'system' ? 'yellow' : 'green'}>{entry.message.role}</Badge>
                    {#if recordPromptEnabled && entry.message.role === 'user' && typeof entry.message.id === 'number'}
                      {@const msgId = entry.message.id}
                      <button
                        class="prompt-btn"
                        title="View the LLM prompt + response for this turn"
                        onclick={() => viewPrompt(msgId, `Message #${msgId}`)}
                      >View Prompt</button>
                      <button
                        class="prompt-btn"
                        title="Copy the LLM prompt + response for this turn to clipboard"
                        onclick={() => copyPrompt(msgId)}
                        disabled={copyPromptState[msgId] === 'loading'}
                      >
                        {#if copyPromptState[msgId] === 'loading'}…
                        {:else if copyPromptState[msgId] === 'copied'}Copied!
                        {:else if copyPromptState[msgId] === 'error'}Failed
                        {:else}Copy{/if}
                      </button>
                    {/if}
                  </div>
                  {#if getImageFilenames(entry.message.metadata).length > 0}
                    <div class="message-images">
                      {#each getImageFilenames(entry.message.metadata) as img}
                        <AuthImage fileName={img} alt="Attached image" className="message-thumb" />
                      {/each}
                    </div>
                  {/if}
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
  <div class="prompt-modal-backdrop" role="button" tabindex="0" onclick={() => { viewPromptData = null; }} onkeydown={(e) => { if (e.key === 'Escape') viewPromptData = null; }}>
    <div class="prompt-modal" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
      <div class="prompt-modal-header">
        <h3>Debug — {viewPromptData.turnLabel}</h3>
        <button class="modal-close" aria-label="Close" onclick={() => { viewPromptData = null; }}>×</button>
      </div>

      {#if viewPromptData.entries.length > 1}
        <div class="round-tabs">
          {#each viewPromptData.entries as e, i}
            <button class="round-tab" class:active={i === activeRound} onclick={() => activeRound = i}>
              Round {e.round}
            </button>
          {/each}
        </div>
      {/if}

      {#if viewPromptData.entries[activeRound]}
        {@const e = viewPromptData.entries[activeRound]}
        <div class="prompt-modal-body">
          <div class="round-meta">
            <span><strong>Turn</strong> {e.turn} · <strong>Round</strong> {e.round}</span>
            <span><strong>Model</strong> {e.model}</span>
            <span><strong>{e.ts}</strong></span>
            {#if e.response?.usage}<span><strong>Tokens</strong> in={e.response.usage.inputTokens ?? 0} out={e.response.usage.outputTokens ?? 0}</span>{/if}
            {#if e.response?.latencyMs}<span><strong>Latency</strong> {e.response.latencyMs}ms</span>{/if}
          </div>

          {#if e.systemPrompt?.cached}
            <div class="prompt-section">
              <div class="prompt-section-head">
                <span>System Prompt (cached)</span>
                <button class="copy-section-btn" onclick={() => copySection('cached', e.systemPrompt!.cached || '')}>
                  {copiedSection === 'cached' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <pre>{e.systemPrompt.cached}</pre>
            </div>
          {/if}

          {#if e.systemPrompt?.dynamic}
            <div class="prompt-section">
              <div class="prompt-section-head">
                <span>System Prompt (dynamic)</span>
                <button class="copy-section-btn" onclick={() => copySection('dynamic', e.systemPrompt!.dynamic || '')}>
                  {copiedSection === 'dynamic' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <pre>{e.systemPrompt.dynamic}</pre>
            </div>
          {/if}

          {#if e.messages?.length}
            <div class="prompt-section">
              <div class="prompt-section-head">
                <span>Messages ({e.messages.length})</span>
                <button class="copy-section-btn" onclick={() => copySection('messages', JSON.stringify(e.messages, null, 2))}>
                  {copiedSection === 'messages' ? 'Copied!' : 'Copy JSON'}
                </button>
              </div>
              <pre>{JSON.stringify(e.messages, null, 2)}</pre>
            </div>
          {/if}

          {#if e.response}
            <div class="prompt-section">
              <div class="prompt-section-head">
                <span>Response</span>
                <button class="copy-section-btn" onclick={() => copySection('response', JSON.stringify(e.response, null, 2))}>
                  {copiedSection === 'response' ? 'Copied!' : 'Copy JSON'}
                </button>
              </div>
              <pre>{JSON.stringify(e.response, null, 2)}</pre>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sessions-page {
    height: calc(100vh - 48px);
    height: calc(100dvh - 48px);
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
  .session-cost { font-size: 10px; font-weight: 600; color: var(--cost, #e0a84c); font-variant-numeric: tabular-nums; }
  .session-count { font-size: 11px; color: var(--text-muted); padding: 4px 10px; }
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
  .messages-list { flex: 1; overflow-y: auto; padding: 12px; }
  .message-row { padding: 12px 14px; margin-bottom: 8px; border-radius: var(--radius); }
  .message-row.user { background: var(--bg-void); }
  .message-row.assistant { background: var(--bg-raised); }
  .message-role { margin-bottom: 6px; }
  .message-images {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .message-thumb {
    max-width: 200px;
    max-height: 150px;
    border-radius: 6px;
    border: 1px solid var(--border);
    object-fit: contain;
    cursor: pointer;
    transition: transform 0.15s;
  }
  .message-thumb:hover { transform: scale(1.05); }
  .message-content { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .message-row.system { background: var(--bg-surface); border-left: 3px solid var(--text-ghost); }

  /* Tool call rows */
  .tool-call-row {
    padding: 8px 14px;
    margin-bottom: 4px;
    border-radius: var(--radius);
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
    .page-title { font-size: 24px; }
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

  /* ── Debug-prompt viewer ───────────────────────────────── */
  .prompt-btn {
    margin-left: 6px;
    padding: 2px 8px;
    font-size: 11px;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-default);
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s;
  }
  .prompt-btn:hover { background: var(--bg-raised); border-color: var(--accent); }
  .prompt-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .prompt-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .prompt-modal {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-width: 1100px;
    width: 100%;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .prompt-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 18px;
    border-bottom: 1px solid var(--border);
  }
  .prompt-modal-header h3 { margin: 0; font-size: 14px; font-weight: 600; }
  .modal-close {
    background: transparent;
    border: none;
    color: var(--text-default);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    padding: 0 6px;
  }
  .modal-close:hover { color: var(--accent); }
  .round-tabs {
    display: flex;
    gap: 4px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .round-tab {
    padding: 4px 10px;
    font-size: 11px;
    background: var(--bg-raised);
    color: var(--text-default);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  .round-tab.active { background: var(--accent); color: var(--bg-void); border-color: var(--accent); }
  .prompt-modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 14px 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .round-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 11px;
    color: var(--text-soft);
    padding: 8px 10px;
    background: var(--bg-void);
    border-radius: var(--radius);
  }
  .prompt-section {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .prompt-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: var(--bg-raised);
    font-size: 12px;
    font-weight: 600;
  }
  .copy-section-btn {
    padding: 2px 8px;
    font-size: 10px;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-default);
    border-radius: 3px;
    cursor: pointer;
  }
  .copy-section-btn:hover { background: var(--bg-void); }
  .prompt-section pre {
    margin: 0;
    padding: 10px 12px;
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 360px;
    overflow-y: auto;
    background: var(--bg-void);
  }
</style>
