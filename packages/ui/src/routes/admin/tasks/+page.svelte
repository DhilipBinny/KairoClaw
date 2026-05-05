<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    getBackgroundTasks,
    stopBackgroundTask,
    clearCompletedTasks,
    type BackgroundTaskRow,
  } from '$lib/api';

  let tasks: BackgroundTaskRow[] = $state([]);
  let count = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let lastRefresh = $state<number | null>(null);
  let stoppingId = $state<string | null>(null);
  let autoRefresh = $state(true);
  let clearing = $state(false);
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  async function load() {
    try {
      const data = await getBackgroundTasks();
      tasks = data.tasks;
      count = data.count;
      lastRefresh = Date.now();
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function stop(id: string) {
    stoppingId = id;
    try {
      await stopBackgroundTask(id);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      stoppingId = null;
    }
  }

  async function clearAll() {
    if (!confirm('Clear all completed/killed/error tasks?')) return;
    clearing = true;
    try {
      await clearCompletedTasks();
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      clearing = false;
    }
  }

  function fmtElapsed(ms: number): string {
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  }

  function fmtTime(ms: number): string {
    return new Date(ms).toLocaleTimeString();
  }

  function statusClass(status: string): string {
    switch (status) {
      case 'running': return 'status-running';
      case 'completed': return 'status-completed';
      case 'error': return 'status-error';
      case 'killed': return 'status-killed';
      default: return '';
    }
  }

  onMount(() => {
    load();
    refreshTimer = setInterval(() => {
      if (autoRefresh) load();
    }, 3000);
  });

  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });
</script>

<svelte:head>
  <title>Background Tasks - Kairo Admin</title>
</svelte:head>

<div class="page">
  <div class="page-header">
    <h1 class="page-title">Background Tasks</h1>
    <p class="page-desc">
      Process-wide view of every task spawned via <code>spawn_agent</code> with
      <code>run_in_background: true</code>. In-memory only — tasks die with the process.
    </p>
  </div>

  <div class="controls">
    <button type="button" class="btn btn-sm" onclick={load} disabled={loading}>
      {loading ? 'Loading…' : 'Refresh'}
    </button>
    {#if tasks.some(t => t.status !== 'running')}
      <button type="button" class="btn btn-sm btn-danger" onclick={clearAll} disabled={clearing}>
        {clearing ? 'Clearing…' : 'Clear Completed'}
      </button>
    {/if}
    <label class="auto-refresh">
      <input type="checkbox" bind:checked={autoRefresh} />
      Auto-refresh (3s)
    </label>
    {#if lastRefresh}
      <span class="meta">Last refresh: {fmtTime(lastRefresh)} · {count} task{count === 1 ? '' : 's'}</span>
    {/if}
  </div>

  {#if error}
    <div class="error-box">{error}</div>
  {/if}

  {#if loading && tasks.length === 0}
    <div class="loading"><span class="spinner"></span> Loading…</div>
  {:else if tasks.length === 0}
    <div class="empty">
      No background tasks currently tracked.
      <br />
      <span class="empty-hint">Spawn one from a chat with <code>spawn_agent</code> + <code>run_in_background: true</code>.</span>
    </div>
  {:else}
    <div class="card">
      <table class="tasks-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Status</th>
            <th>Elapsed</th>
            <th>Scope</th>
            <th>Task</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each tasks as t (t.id)}
            <tr>
              <td class="mono">{t.id}</td>
              <td>
                <span class="status-badge {statusClass(t.status)}">{t.status}</span>
              </td>
              <td class="mono">{fmtElapsed(t.elapsedMs)}</td>
              <td class="mono scope-cell">{t.scopeKey || '—'}</td>
              <td class="task-cell">
                <details>
                  <summary>{t.task.slice(0, 80)}{t.task.length > 80 ? '…' : ''}</summary>
                  <pre class="task-full">{t.task}</pre>
                  {#if t.resultPreview}
                    <div class="label-sm">Result preview</div>
                    <pre class="task-full">{t.resultPreview}</pre>
                  {/if}
                  {#if t.error}
                    <div class="label-sm">Error</div>
                    <pre class="task-full err">{t.error}</pre>
                  {/if}
                </details>
              </td>
              <td>
                {#if t.status === 'running'}
                  <button
                    type="button"
                    class="btn btn-sm btn-danger"
                    onclick={() => stop(t.id)}
                    disabled={stoppingId === t.id}
                  >
                    {stoppingId === t.id ? 'Stopping…' : 'Stop'}
                  </button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .page { max-width: 1200px; }
  .page-header { margin-bottom: 20px; }
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.3px; }
  .page-desc { color: var(--text-muted); font-size: 14px; max-width: 800px; }
  .page-desc code {
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12px;
    font-family: var(--font-mono);
  }

  .controls {
    display: flex;
    gap: 14px;
    align-items: center;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .auto-refresh {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .meta {
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .btn {
    padding: 6px 14px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
  }
  .btn:hover { border-color: var(--accent); }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .btn-danger { color: #ef4444; border-color: rgba(239, 68, 68, 0.35); }
  .btn-danger:hover { background: rgba(239, 68, 68, 0.1); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
    overflow-x: auto;
  }

  .tasks-table {
    width: 100%;
    border-collapse: collapse;
  }
  .tasks-table th {
    text-align: left;
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid var(--border);
  }
  .tasks-table td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-subtle, var(--border));
    font-size: 13px;
    vertical-align: top;
  }
  .tasks-table tr:last-child td { border-bottom: none; }

  .mono { font-family: var(--font-mono); font-size: 12px; }
  .scope-cell { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-cell summary { cursor: pointer; }
  .task-full {
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px;
    margin: 6px 0;
    font-family: var(--font-mono);
    font-size: 11px;
    max-height: 200px;
    overflow: auto;
  }
  .task-full.err { color: #ef4444; }
  .label-sm {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 6px;
  }

  .status-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .status-running {
    background: rgba(56, 189, 248, 0.15);
    color: #38bdf8;
  }
  .status-completed {
    background: rgba(52, 211, 153, 0.15);
    color: #22c55e;
  }
  .status-error {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }
  .status-killed {
    background: rgba(148, 163, 184, 0.15);
    color: #94a3b8;
  }

  .empty {
    padding: 40px 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: 14px;
    background: var(--bg-surface);
    border: 1px dashed var(--border);
    border-radius: var(--radius);
  }
  .empty code {
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .empty-hint { font-size: 12px; color: var(--text-muted); }

  .error-box {
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.35);
    color: #ef4444;
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 13px;
    margin-bottom: 12px;
  }
  .loading {
    color: var(--text-muted);
    padding: 16px 0;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
  }
</style>
