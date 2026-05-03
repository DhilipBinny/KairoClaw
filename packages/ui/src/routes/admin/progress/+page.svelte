<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getSessions } from '$lib/api';

  interface ProgressEvent {
    sessionId: string;
    timestamp: number;
    kind: string;
    toolName?: string;
    toolCallId?: string;
    message?: string;
    fraction?: number;
    data?: unknown;
    durationMs?: number;
    argsPreview?: string;
    argsLen?: number;
    resultPreview?: string;
    resultLen?: number;
    resultPersisted?: boolean;
  }

  interface SessionRow {
    id: string;
    channel: string;
    turns: number;
    input_tokens: number;
    output_tokens: number;
    created_at: string;
    updated_at: string;
  }

  // Sentinel for "follow every session in the process" — maps to the
  // server-side ProgressBus.subscribeAll() path.
  const ALL_SESSIONS = '*';

  let sessions = $state<SessionRow[]>([]);
  let selectedSessionId = $state<string>(ALL_SESSIONS);
  let events = $state<ProgressEvent[]>([]);
  let expanded = $state<Set<number>>(new Set());
  let loadingSessions = $state(true);
  let eventSource: EventSource | undefined;
  let connected = $state(false);
  let connError = $state<string>('');
  let autoScroll = $state(true);
  let feedEl: HTMLDivElement | undefined;

  function toggleExpanded(idx: number) {
    const next = new Set(expanded);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    expanded = next;
  }

  /**
   * Try to pretty-print a JSON preview. If the preview was truncated
   * with `…` it won't parse — fall back to raw text. Either way,
   * returns a string that renders cleanly in a monospace box.
   */
  function prettyJson(preview: string | undefined): string {
    if (!preview) return '';
    try {
      return JSON.stringify(JSON.parse(preview), null, 2);
    } catch {
      return preview;
    }
  }

  async function loadSessions() {
    loadingSessions = true;
    try {
      const res = await getSessions(100);
      sessions = (res.sessions || []).sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
      // Leave the default as the wildcard "*" (all sessions) so the
      // user sees events from the moment they open the page without
      // having to guess which session to pick.
    } catch (e) {
      connError = e instanceof Error ? e.message : 'Failed to load sessions';
    } finally {
      loadingSessions = false;
    }
  }

  function disconnect() {
    if (eventSource) {
      try { eventSource.close(); } catch { /* ignore */ }
      eventSource = undefined;
    }
    connected = false;
  }

  function connect(sessionId: string) {
    disconnect();
    events = [];
    connError = '';

    if (!sessionId) return;

    // EventSource can't send custom headers, so pass the API key as a
    // query-string token. The Fastify auth middleware already accepts
    // `?token=...` as a fallback for API-key auth.
    const apiKey = typeof window !== 'undefined' ? localStorage.getItem('agw_api_key') : null;
    if (!apiKey) {
      connError = 'No API key in localStorage — sign in again.';
      return;
    }

    const url = `/api/v1/sessions/${encodeURIComponent(sessionId)}/progress?token=${encodeURIComponent(apiKey)}`;

    try {
      eventSource = new EventSource(url);
    } catch (e) {
      connError = e instanceof Error ? e.message : 'EventSource error';
      return;
    }

    eventSource.onopen = () => {
      connected = true;
    };

    eventSource.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as ProgressEvent;
        events = [...events, parsed];
        // Keep the last 500 events in memory to prevent growth on
        // long-lived streams.
        if (events.length > 500) {
          events = events.slice(-500);
        }
        // Auto-scroll the feed to the bottom on each new event.
        if (autoScroll && feedEl) {
          queueMicrotask(() => {
            if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
          });
        }
      } catch {
        /* ignore malformed line */
      }
    };

    eventSource.onerror = () => {
      connected = false;
      // Leave the connection alive — EventSource auto-reconnects on
      // network blips. Only surface a user-visible error if we never
      // connected at all (first-connect failure).
      if (events.length === 0) {
        connError = 'Connection error (retrying)';
      }
    };
  }

  function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  }

  function kindBadgeClass(kind: string): string {
    if (kind === 'tool.start') return 'badge-blue';
    if (kind === 'tool.complete') return 'badge-green';
    if (kind === 'tool.error') return 'badge-red';
    if (kind === 'tool.progress') return 'badge-yellow';
    if (kind === 'stream.open') return 'badge-gray';
    return 'badge-default';
  }

  // Reactively reconnect when the selected session changes.
  $effect(() => {
    if (selectedSessionId) {
      connect(selectedSessionId);
    }
  });

  onMount(() => {
    loadSessions();
  });

  onDestroy(() => {
    disconnect();
  });
</script>

<svelte:head>
  <title>Live Progress — Admin — Kairo</title>
</svelte:head>

<div class="progress-page">
  <div class="page-header">
    <h1 class="page-title">Live Progress</h1>
    <p class="page-desc">
      Watch tool-execution events stream from the agent in real time. Events include <code>tool.start</code>,
      <code>tool.progress</code>, <code>tool.complete</code>, and <code>tool.error</code>.
    </p>
  </div>

  <div class="controls">
    <label class="select-wrap">
      <span class="label">Session:</span>
      {#if loadingSessions}
        <span class="muted">Loading…</span>
      {:else}
        <select bind:value={selectedSessionId}>
          <option value={ALL_SESSIONS}>⭐ All sessions (live tail)</option>
          {#each sessions as s}
            <option value={s.id}>
              [{s.channel}] {s.id.slice(0, 8)}… · {s.turns} turns · updated {new Date(s.updated_at).toLocaleTimeString()}
            </option>
          {/each}
        </select>
      {/if}
    </label>

    <button class="btn" onclick={loadSessions}>Refresh sessions</button>

    <span class="status">
      {#if connected}
        <span class="dot dot-green"></span> Connected
      {:else if connError}
        <span class="dot dot-red"></span> {connError}
      {:else}
        <span class="dot dot-gray"></span> Idle
      {/if}
    </span>

    <label class="auto-scroll">
      <input type="checkbox" bind:checked={autoScroll} />
      Auto-scroll
    </label>

    <button class="btn" onclick={() => { events = []; }}>Clear feed</button>
  </div>

  <div class="feed" bind:this={feedEl}>
    {#if events.length === 0}
      <div class="empty">
        {#if selectedSessionId === ALL_SESSIONS}
          Waiting for tool activity on any session. Send a message to the agent via Telegram, webchat, or the HTTP API to see events appear here.
        {:else if selectedSessionId}
          Waiting for the next tool call on this session. If you're chatting from a different channel (Telegram vs. webchat), switch to "⭐ All sessions" above to tail everything.
        {:else}
          Select a session above to start streaming.
        {/if}
      </div>
    {:else}
      {#each events as evt, i}
        {@const hasDetails = !!(evt.argsPreview || evt.resultPreview)}
        <div class="event" class:expandable={hasDetails} class:is-expanded={expanded.has(i)}>
          <button
            class="event-row"
            type="button"
            onclick={() => hasDetails && toggleExpanded(i)}
            disabled={!hasDetails}
          >
            {#if hasDetails}
              <span class="chevron">{expanded.has(i) ? '▾' : '▸'}</span>
            {:else}
              <span class="chevron chevron-spacer"></span>
            {/if}
            <span class="time">{formatTime(evt.timestamp)}</span>
            <span class="kind {kindBadgeClass(evt.kind)}">{evt.kind}</span>
            {#if evt.toolName}
              <span class="tool">{evt.toolName}</span>
            {/if}
            {#if evt.message}
              <span class="msg">{evt.message}</span>
            {/if}
            {#if evt.durationMs !== undefined}
              <span class="duration">{evt.durationMs}ms</span>
            {/if}
            {#if evt.fraction !== undefined}
              <span class="fraction">{Math.round(evt.fraction * 100)}%</span>
            {/if}
            {#if evt.resultPersisted}
              <span class="persisted-tag" title="Result was offloaded to disk">persisted</span>
            {/if}
          </button>

          {#if expanded.has(i)}
            <div class="event-details">
              {#if evt.argsPreview}
                <div class="detail-section">
                  <div class="detail-label">
                    Input args
                    {#if evt.argsLen !== undefined && evt.argsLen > (evt.argsPreview.length - (evt.argsPreview.endsWith('…') ? 1 : 0))}
                      <span class="truncated">(truncated, full {evt.argsLen} chars)</span>
                    {/if}
                  </div>
                  <pre class="detail-body">{prettyJson(evt.argsPreview)}</pre>
                </div>
              {/if}
              {#if evt.resultPreview}
                <div class="detail-section">
                  <div class="detail-label">
                    Result preview
                    {#if evt.resultLen !== undefined && evt.resultLen > (evt.resultPreview.length - (evt.resultPreview.endsWith('…') ? 1 : 0))}
                      <span class="truncated">(truncated, full {evt.resultLen} chars)</span>
                    {/if}
                  </div>
                  <pre class="detail-body">{evt.resultPreview}</pre>
                </div>
              {/if}
              {#if evt.toolCallId}
                <div class="detail-meta">callId: <code>{evt.toolCallId}</code></div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  <div class="footer">
    <span class="muted">{events.length} event{events.length === 1 ? '' : 's'}</span>
  </div>
</div>

<style>
  .progress-page { max-width: 1100px; }
  .page-header { margin-bottom: 20px; }
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.3px; }
  .page-desc { color: var(--text-muted); font-size: 14px; }
  .page-desc code {
    background: var(--bg-raised);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 16px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .select-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 280px;
  }
  .select-wrap select {
    flex: 1;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--text-primary);
    font-size: 13px;
    min-width: 0;
  }
  .label { font-size: 13px; color: var(--text-muted); white-space: nowrap; }
  .muted { color: var(--text-muted); font-size: 13px; }

  .status { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot-green { background: #22c55e; box-shadow: 0 0 6px rgba(34, 197, 94, 0.5); }
  .dot-red { background: #ef4444; }
  .dot-gray { background: var(--text-ghost); }

  .auto-scroll {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .btn {
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--text-primary);
    font-size: 13px;
    cursor: pointer;
  }
  .btn:hover { background: var(--bg-raised); }

  .feed {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    height: 60vh;
    overflow-y: auto;
    padding: 12px 16px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .empty {
    color: var(--text-muted);
    text-align: center;
    padding: 40px 0;
    font-family: var(--font);
    font-size: 13px;
  }
  .event {
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.04));
  }
  .event:last-child { border-bottom: none; }
  .event.is-expanded {
    background: var(--bg-raised, rgba(255, 255, 255, 0.02));
  }

  .event-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 4px 0;
    background: none;
    border: none;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    text-align: left;
    cursor: default;
  }
  .event.expandable .event-row { cursor: pointer; }
  .event.expandable .event-row:hover { background: var(--bg-raised, rgba(255, 255, 255, 0.03)); }

  .chevron {
    color: var(--text-ghost);
    font-size: 11px;
    width: 10px;
    flex-shrink: 0;
    user-select: none;
  }
  .chevron-spacer { visibility: hidden; }

  .event-details {
    padding: 10px 18px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-family: var(--font-mono);
  }
  .detail-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .detail-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--text-muted);
  }
  .truncated {
    font-weight: 400;
    text-transform: none;
    color: var(--text-ghost);
    letter-spacing: 0;
    margin-left: 6px;
  }
  .detail-body {
    margin: 0;
    padding: 8px 10px;
    background: var(--bg, #0a0a0a);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 11px;
    line-height: 1.45;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 260px;
    overflow-y: auto;
  }
  .detail-meta {
    font-size: 10px;
    color: var(--text-ghost);
  }
  .detail-meta code {
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .persisted-tag {
    background: rgba(250, 204, 21, 0.15);
    color: #facc15;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    flex-shrink: 0;
  }

  .time { color: var(--text-ghost); font-size: 11px; flex-shrink: 0; }
  .kind {
    padding: 1px 7px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    flex-shrink: 0;
  }
  .badge-blue { background: rgba(99, 102, 241, 0.15); color: #818cf8; }
  .badge-green { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
  .badge-red { background: rgba(239, 68, 68, 0.15); color: #f87171; }
  .badge-yellow { background: rgba(250, 204, 21, 0.15); color: #facc15; }
  .badge-gray { background: rgba(156, 163, 175, 0.15); color: #9ca3af; }
  .badge-default { background: var(--bg-raised); color: var(--text-secondary); }

  .tool { color: var(--accent); font-weight: 600; flex-shrink: 0; }
  .msg { color: var(--text-secondary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .duration { color: var(--text-muted); font-size: 11px; flex-shrink: 0; }
  .fraction { color: var(--text-muted); font-size: 11px; flex-shrink: 0; }

  .footer {
    margin-top: 8px;
    display: flex;
    justify-content: flex-end;
  }
</style>
