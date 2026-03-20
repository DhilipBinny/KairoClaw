<script lang="ts">
  import { getLogs, getLogFiles, searchLogs, setLogLevel } from '$lib/api';
  import type { LogEntry, LogFile } from '$lib/api';
  import Badge from './Badge.svelte';

  let mode = $state<'live' | 'search'>('live');

  // Live mode
  let expandedIdx: number | null = $state(null);
  let logs: LogEntry[] = $state([]);
  let buffered = $state(0);
  let levelFilter: string = $state('all');
  let categoryFilter: string = $state('all');
  let filteredLogs: LogEntry[] = $derived(
    logs.filter((l) => {
      if (levelFilter !== 'all' && l.level !== levelFilter) return false;
      if (categoryFilter !== 'all' && l.category !== categoryFilter) return false;
      return true;
    })
  );
  let autoScroll: boolean = $state(true);
  let container: HTMLDivElement | undefined = $state();
  let loading: boolean = $state(false);
  let currentLogLevel: string = $state('info');

  // Search mode
  let searchQuery = $state('');
  let searchLevel = $state('');
  let searchFrom = $state('');
  let searchTo = $state('');
  let searchResults: LogEntry[] = $state([]);
  let searchCount = $state(0);
  let searching = $state(false);

  // Files
  let logFiles: LogFile[] = $state([]);

  const categories = ['all', 'llm', 'tool', 'mcp', 'channel.telegram', 'channel.whatsapp', 'channel.web', 'cron', 'memory', 'auth', 'config', 'system'];

  const levels = ['all', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const logLevelOptions = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function fetchLogs() {
    loading = true;
    try {
      const data = await getLogs(500);
      logs = Array.isArray(data.entries) ? data.entries : (Array.isArray(data) ? data as unknown as LogEntry[] : []);
      buffered = data.buffered || logs.length;
    } catch (e) {
      console.error('Failed to fetch logs:', e);
    } finally {
      loading = false;
    }
  }

  async function fetchFiles() {
    try {
      const data = await getLogFiles();
      logFiles = data.files || [];
    } catch { /* non-critical */ }
  }

  async function handleSearch() {
    if (!searchQuery && !searchLevel) return;
    searching = true;
    try {
      const data = await searchLogs({
        q: searchQuery || undefined,
        level: searchLevel || undefined,
        from: searchFrom || undefined,
        to: searchTo || undefined,
        limit: 500,
      });
      searchResults = data.entries;
      searchCount = data.count;
    } catch (e) {
      console.error('Search failed:', e);
    } finally {
      searching = false;
    }
  }

  async function changeLogLevel(level: string) {
    try {
      await setLogLevel(level);
      currentLogLevel = level;
    } catch (e) {
      console.error('Failed to set log level:', e);
    }
  }

  function levelBadgeVariant(level: string): 'green' | 'yellow' | 'red' | 'blue' | 'default' {
    switch (level) {
      case 'error': case 'fatal': return 'red';
      case 'warn': return 'yellow';
      case 'info': return 'blue';
      default: return 'default';
    }
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }

  function formatDate(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  $effect(() => {
    fetchLogs();
    fetchFiles();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  });

  $effect(() => {
    if (autoScroll && container && filteredLogs.length > 0) {
      requestAnimationFrame(() => {
        container?.scrollTo({ top: container.scrollHeight });
      });
    }
  });
</script>

<div class="log-viewer">
  <!-- Mode tabs -->
  <div class="log-tabs">
    <button class="tab-btn" class:active={mode === 'live'} onclick={() => mode = 'live'}>Live</button>
    <button class="tab-btn" class:active={mode === 'search'} onclick={() => mode = 'search'}>Search</button>
  </div>

  {#if mode === 'live'}
    <!-- Live mode toolbar -->
    <div class="log-toolbar">
      <div class="log-filters">
        {#each levels as level}
          <button class="filter-btn" class:active={levelFilter === level} onclick={() => levelFilter = level}>
            {level}
          </button>
        {/each}
      </div>
      <select class="input input-sm category-select" bind:value={categoryFilter}>
        {#each categories as cat}
          <option value={cat}>{cat === 'all' ? 'All modules' : cat}</option>
        {/each}
      </select>
      <div class="log-controls">
        <span class="log-stat">{buffered} buffered</span>
        <label class="log-autoscroll">
          <input type="checkbox" bind:checked={autoScroll} /> Auto-scroll
        </label>
        <select class="input input-sm" onchange={(e) => changeLogLevel((e.target as HTMLSelectElement).value)}>
          {#each logLevelOptions as opt}
            <option value={opt} selected={opt === currentLogLevel}>{opt}</option>
          {/each}
        </select>
        <button class="btn btn-sm" onclick={fetchLogs} disabled={loading}>Refresh</button>
      </div>
    </div>

    <!-- Live log entries -->
    <div class="log-entries" bind:this={container}>
      {#each filteredLogs as entry, i}
        <div class="log-entry" class:expanded={expandedIdx === i} onclick={() => expandedIdx = expandedIdx === i ? null : i} role="button" tabindex="0">
          <span class="log-time">{formatTime(entry.time)}</span>
          <Badge variant={levelBadgeVariant(entry.level)}>{entry.level}</Badge>
          {#if entry.category}<span class="log-cat">{entry.category}</span>{/if}
          <span class="log-msg">{entry.msg}</span>
        </div>
        {#if expandedIdx === i}
          <pre class="log-detail">{JSON.stringify(entry, null, 2)}</pre>
        {/if}
      {:else}
        <div class="log-empty">{loading ? 'Loading...' : 'No logs to display'}</div>
      {/each}
    </div>

  {:else}
    <!-- Search mode -->
    <div class="search-toolbar">
      <div class="search-row">
        <input class="input search-input" type="text" bind:value={searchQuery} placeholder="Search logs..." onkeydown={(e) => { if (e.key === 'Enter') handleSearch(); }} />
        <select class="input input-sm" bind:value={searchLevel}>
          <option value="">All levels</option>
          {#each logLevelOptions as opt}
            <option value={opt}>{opt}</option>
          {/each}
        </select>
        <input class="input input-sm" type="date" bind:value={searchFrom} />
        <input class="input input-sm" type="date" bind:value={searchTo} />
        <button class="btn btn-sm btn-primary" onclick={handleSearch} disabled={searching}>
          {searching ? 'Searching...' : 'Search'}
        </button>
      </div>
    </div>

    <!-- Search results -->
    <div class="log-entries">
      {#each searchResults as entry}
        <div class="log-entry">
          <span class="log-time">{formatDate(entry.time)}</span>
          <Badge variant={levelBadgeVariant(entry.level)}>{entry.level}</Badge>
          <span class="log-msg">{entry.msg}</span>
        </div>
      {:else}
        <div class="log-empty">{searching ? 'Searching...' : searchCount === 0 && searchQuery ? 'No results' : 'Enter a search query'}</div>
      {/each}
    </div>

    <!-- Log files list -->
    {#if logFiles.length > 0}
      <div class="log-files">
        <h4 class="files-title">Log Files</h4>
        <div class="files-list">
          {#each logFiles as file}
            <div class="file-row">
              <span class="file-date">{file.date}</span>
              <span class="file-size">{formatBytes(file.sizeBytes)}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .log-viewer { display: flex; flex-direction: column; height: 100%; }
  .log-tabs { display: flex; gap: 2px; margin-bottom: 12px; background: var(--bg-raised); padding: 3px; border-radius: var(--radius); width: fit-content; }
  .tab-btn { padding: 5px 16px; font-size: 12px; font-weight: 500; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); cursor: pointer; font-family: var(--font); }
  .tab-btn.active { background: var(--accent); color: #fff; }
  .log-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; flex-wrap: wrap; }
  .log-filters { display: flex; gap: 2px; background: var(--bg-raised); padding: 3px; border-radius: var(--radius); }
  .filter-btn { padding: 3px 8px; font-size: 11px; font-family: var(--font); font-weight: 500; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); cursor: pointer; text-transform: capitalize; }
  .filter-btn:hover { color: var(--text-primary); background: var(--bg-overlay); }
  .filter-btn.active { background: var(--accent); color: #fff; }
  .log-controls { display: flex; align-items: center; gap: 10px; }
  .log-stat { font-size: 11px; color: var(--text-muted); }
  .log-autoscroll { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-secondary); cursor: pointer; }
  .log-entries { flex: 1; overflow-y: auto; background: var(--bg-void); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px; font-family: var(--font-mono); font-size: 12px; line-height: 1.7; min-height: 300px; }
  .log-entry { display: flex; align-items: baseline; gap: 8px; padding: 1px 6px; border-radius: 3px; }
  .log-entry:hover { background: var(--bg-surface); }
  .log-time { color: var(--text-muted); flex-shrink: 0; font-size: 11px; }
  .log-entry { cursor: pointer; }
  .log-entry.expanded { background: var(--bg-surface); }
  .log-detail { margin: 0 0 4px 0; padding: 8px 12px; font-size: 11px; line-height: 1.4; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); color: var(--text-secondary); overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .log-cat { color: var(--accent); font-size: 10px; font-weight: 500; background: var(--accent-subtle); padding: 0 5px; border-radius: 3px; flex-shrink: 0; }
  .log-msg { color: var(--text-primary); word-break: break-all; }
  .category-select { width: 140px; font-size: 11px; padding: 3px 6px; }
  .log-empty { padding: 40px; text-align: center; color: var(--text-muted); }

  .search-toolbar { padding: 8px 0; }
  .search-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .search-input { flex: 1; min-width: 200px; }
  .input-sm { padding: 5px 8px; font-size: 12px; }

  .log-files { margin-top: 16px; padding: 12px; background: var(--bg-raised); border-radius: var(--radius); }
  .files-title { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .files-list { display: flex; flex-direction: column; gap: 4px; }
  .file-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; font-size: 12px; background: var(--bg-void); border-radius: var(--radius-sm); }
  .file-date { font-family: var(--font-mono); color: var(--text-secondary); }
  .file-size { color: var(--text-muted); font-size: 11px; }
</style>
