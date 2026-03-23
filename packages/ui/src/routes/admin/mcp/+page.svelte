<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getMCPServers, getMCPCatalog, searchMCPMarketplace, installMCPServer, removeMCPServer, reconnectMCPServer, disableMCPServer, enableMCPServer, updateMCPServer } from '$lib/api';
  import Badge from '$lib/components/Badge.svelte';

  interface EnvVarSpec {
    key: string;
    label: string;
    required: boolean;
    sensitive: boolean;
    placeholder?: string;
    helpUrl?: string;
  }

  interface MCPServer {
    id: string;
    status: string;
    statusMessage?: string | null;
    error?: string | null;
    tools: string[];
    toolCount?: number;
    envKeys?: string[];
    config?: { enabled?: boolean };
  }

  interface CatalogEntry {
    id: string;
    name: string;
    description: string;
    package: string;
    transport: string;
    command: string;
    args: string[];
    envVars: EnvVarSpec[];
    category: string;
    installed: boolean;
    enabled: boolean;
    envStatus: Record<string, boolean>;
  }

  interface MarketplaceEntry {
    id: string;
    name: string;
    description: string;
    qualifiedName: string;
    package?: string;
    installable?: boolean;
    transport?: string;
  }

  let servers: MCPServer[] = $state([]);
  let catalog: CatalogEntry[] = $state([]);
  let marketplaceResults: MarketplaceEntry[] = $state([]);
  let searchQuery = $state('');
  let loading = $state(true);
  let searching = $state(false);
  let actionInProgress = $state('');

  // Install form state
  let installTarget = $state<CatalogEntry | null>(null);
  let installEnvValues = $state<Record<string, string>>({});
  let installError = $state('');

  // Env var editor state (for installed servers)
  let envEditorOpen = $state<string | null>(null);
  let envEditorValues = $state<Record<string, string>>({});

  // Polling
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let searchTimeout: ReturnType<typeof setTimeout>;

  function hasTransitionalServers(): boolean {
    return servers.some(s => s.status === 'installing' || s.status === 'connecting');
  }

  function startPolling() {
    stopPolling();
    if (hasTransitionalServers()) {
      pollTimer = setInterval(async () => {
        await loadServersOnly();
        if (!hasTransitionalServers()) stopPolling();
      }, 3000);
    }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function loadServersOnly() {
    try {
      const data = await getMCPServers().catch(() => ({ servers: [] }));
      const raw = (data as any).servers;
      if (Array.isArray(raw)) servers = raw;
      else if (raw && typeof raw === 'object') servers = Object.entries(raw).map(([id, s]: [string, any]) => ({ id, ...s }));
      else servers = [];
    } catch { /* ignore */ }
  }

  async function loadData() {
    loading = true;
    try {
      const [serversData, catalogData] = await Promise.all([
        getMCPServers().catch(() => ({ servers: [] })),
        getMCPCatalog().catch(() => ({ catalog: [] })),
      ]);
      const raw = (serversData as any).servers;
      if (Array.isArray(raw)) servers = raw;
      else if (raw && typeof raw === 'object') servers = Object.entries(raw).map(([id, s]: [string, any]) => ({ id, ...s }));
      else servers = [];
      catalog = (catalogData.catalog || []) as CatalogEntry[];
    } catch (e) {
      console.error('Failed to load MCP data:', e);
    } finally {
      loading = false;
      startPolling();
    }
  }

  // ── Install from catalog ───────────────────
  function openInstallForm(entry: CatalogEntry) {
    installTarget = entry;
    installEnvValues = {};
    installError = '';
    for (const v of entry.envVars) {
      installEnvValues[v.key] = '';
    }
  }

  function closeInstallForm() {
    installTarget = null;
    installEnvValues = {};
    installError = '';
  }

  async function handleInstall() {
    if (!installTarget) return;
    const entry = installTarget;

    // Validate required
    const missing = entry.envVars
      .filter(v => v.required && !installEnvValues[v.key]?.trim() && !entry.envStatus[v.key]);
    if (missing.length > 0) {
      installError = `Required: ${missing.map(v => v.label).join(', ')}`;
      return;
    }

    actionInProgress = entry.id;
    installError = '';
    try {
      // Build env with only non-empty values
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(installEnvValues)) {
        if (v.trim()) env[k] = v.trim();
      }
      await installMCPServer({ id: entry.id, env });
      closeInstallForm();
      await loadData();
    } catch (e: any) {
      installError = e?.message || 'Install failed';
    } finally {
      actionInProgress = '';
    }
  }

  // ── Search ─────────────────────────────────
  async function handleSearch() {
    if (!searchQuery.trim() || searchQuery.trim().length < 3) {
      marketplaceResults = [];
      return;
    }
    searching = true;
    try {
      const data = await searchMCPMarketplace(searchQuery);
      marketplaceResults = data.servers || [];
    } catch { /* ignore */ }
    finally { searching = false; }
  }

  function onSearchInput() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(handleSearch, 800);
  }

  // ── Server actions ─────────────────────────
  async function handleRemove(id: string) {
    actionInProgress = id;
    try { await removeMCPServer(id); await loadData(); } catch { /* ignore */ }
    finally { actionInProgress = ''; }
  }

  async function handleToggle(id: string, status: string) {
    actionInProgress = `toggle-${id}`;
    try {
      if (status === 'connected' || status === 'connecting' || status === 'installing') await disableMCPServer(id);
      else await enableMCPServer(id);
      await loadData();
    } catch { /* ignore */ }
    finally { actionInProgress = ''; }
  }

  async function handleReconnect(id: string) {
    actionInProgress = `reconnect-${id}`;
    try { await reconnectMCPServer(id); await loadData(); } catch { /* ignore */ }
    finally { actionInProgress = ''; }
  }

  function toggleEnvEditor(server: MCPServer) {
    if (envEditorOpen === server.id) {
      envEditorOpen = null; envEditorValues = {};
    } else {
      envEditorOpen = server.id;
      envEditorValues = {};
      if (server.envKeys) for (const key of server.envKeys) envEditorValues[key] = '';
    }
  }

  async function handleSaveEnv(id: string) {
    actionInProgress = `env-${id}`;
    try {
      const cleanEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(envEditorValues)) {
        if (!k.startsWith('_') && v !== '') cleanEnv[k] = v;
      }
      if (Object.keys(cleanEnv).length > 0) await updateMCPServer(id, { env: cleanEnv });
      envEditorOpen = null; envEditorValues = {};
      await loadData();
    } catch { /* ignore */ }
    finally { actionInProgress = ''; }
  }

  function statusVariant(status: string): 'green' | 'yellow' | 'red' | 'default' {
    if (status === 'connected') return 'green';
    if (status === 'installing' || status === 'connecting') return 'yellow';
    if (status === 'error' || status === 'disconnected') return 'red';
    return 'default';
  }

  // Group catalog by category
  function catalogByCategory(): [string, CatalogEntry[]][] {
    const groups = new Map<string, CatalogEntry[]>();
    for (const entry of catalog) {
      const cat = entry.category || 'other';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(entry);
    }
    // Sort: installed-first categories
    const order = ['development', 'communication', 'search', 'utilities', 'data', 'cloud', 'productivity'];
    return order.filter(c => groups.has(c)).map(c => [c, groups.get(c)!]);
  }

  onMount(loadData);
  onDestroy(stopPolling);
</script>

<svelte:head>
  <title>MCP Servers - Admin - Kairo</title>
</svelte:head>

<div class="mcp-page">
  <div class="page-header">
    <h1 class="page-title">MCP Servers</h1>
    <p class="page-desc">Manage Model Context Protocol servers and discover new tools.</p>
  </div>

  {#if loading}
    <div class="loading"><span class="spinner"></span> Loading...</div>
  {:else}
    <!-- ── Installed Servers ────────────────── -->
    {#if servers.length > 0}
    <div class="section">
      <h2 class="section-title">Installed <span class="section-count">{servers.length}</span></h2>
      <div class="server-list">
        {#each servers as server}
          <div class="card server-card">
            <div class="server-header">
              <div>
                <h3 class="server-name">{server.id}</h3>
                {#if server.statusMessage}
                  <div class="server-status-msg">
                    {#if server.status === 'installing' || server.status === 'connecting'}
                      <span class="spinner" style="width:10px;height:10px;border-width:2px;"></span>
                    {/if}
                    {server.statusMessage}
                  </div>
                {/if}
                {#if server.error && server.status === 'error'}
                  <div class="server-error">{server.error}</div>
                {/if}
                {#if server.tools?.length}
                  <div class="server-tools">
                    <span class="tools-count">{server.tools.length} tool{server.tools.length !== 1 ? 's' : ''}</span>
                    <span class="tools-names">{server.tools.slice(0, 5).join(', ')}{server.tools.length > 5 ? '...' : ''}</span>
                  </div>
                {/if}
              </div>
              <Badge variant={statusVariant(server.status)}>{server.status}</Badge>
            </div>
            <div class="server-actions">
              <button class="btn btn-sm" onclick={() => handleToggle(server.id, server.status)} disabled={actionInProgress === `toggle-${server.id}`}>
                {(server.status === 'connected' || server.status === 'connecting') ? 'Disable' : 'Enable'}
              </button>
              <button class="btn btn-sm" onclick={() => handleReconnect(server.id)} disabled={actionInProgress === `reconnect-${server.id}`}>Reconnect</button>
              <button class="btn btn-sm" onclick={() => toggleEnvEditor(server)}>Env{server.envKeys?.length ? ` (${server.envKeys.length})` : ''}</button>
              <button class="btn btn-sm btn-danger" onclick={() => handleRemove(server.id)} disabled={actionInProgress === server.id}>Remove</button>
            </div>

            {#if envEditorOpen === server.id}
              <div class="env-editor">
                <h4 class="env-editor-title">Environment Variables</h4>
                {#each Object.entries(envEditorValues).filter(([k]) => !k.startsWith('_')) as [key]}
                  <div class="env-field">
                    <span class="env-label">{key} {#if server.envKeys?.includes(key)}<span class="env-configured">configured</span>{/if}</span>
                    <input class="input input-sm" type="password" placeholder={server.envKeys?.includes(key) ? '(leave empty to keep)' : 'value'} bind:value={envEditorValues[key]} />
                  </div>
                {/each}
                <div class="env-fields">
                  <div class="env-field">
                    <span class="env-label">New Key</span>
                    <input class="input input-sm" type="text" placeholder="ENV_KEY" bind:value={envEditorValues._newKey} />
                  </div>
                  <div class="env-field">
                    <span class="env-label">Value</span>
                    <input class="input input-sm" type="password" placeholder="value" bind:value={envEditorValues._newValue} />
                  </div>
                </div>
                <div class="env-actions">
                  <button class="btn btn-sm" onclick={() => { if (envEditorValues._newKey) { envEditorValues[envEditorValues._newKey] = envEditorValues._newValue || ''; envEditorValues._newKey = ''; envEditorValues._newValue = ''; envEditorValues = {...envEditorValues}; } }}>Add</button>
                  <button class="btn btn-sm btn-primary" onclick={() => handleSaveEnv(server.id)} disabled={actionInProgress === `env-${server.id}`}>
                    {actionInProgress === `env-${server.id}` ? 'Saving...' : 'Save & Reconnect'}
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
    {/if}

    <!-- ── Catalog ─────────────────────────── -->
    <div class="section">
      <h2 class="section-title">Available Servers</h2>
      {#each catalogByCategory() as [category, entries]}
        <h3 class="category-title">{category}</h3>
        <div class="catalog-grid">
          {#each entries as entry}
            <div class="card catalog-card" class:installed={entry.installed}>
              <div class="catalog-header">
                <h4 class="catalog-name">{entry.name}</h4>
                {#if entry.installed}
                  <Badge variant="green">Installed</Badge>
                {/if}
              </div>
              <p class="catalog-desc">{entry.description}</p>
              {#if !entry.installed}
                {#if installTarget?.id === entry.id}
                  <!-- Install form -->
                  <div class="install-form">
                    {#each entry.envVars as spec}
                      <div class="env-field">
                        <span class="env-label">
                          {spec.label}
                          {#if spec.required}<span class="required">*</span>{/if}
                          {#if spec.helpUrl}<a href={spec.helpUrl} target="_blank" rel="noopener noreferrer" class="help-link">Get</a>{/if}
                        </span>
                        <input
                          class="input input-sm"
                          type={spec.sensitive ? 'password' : 'text'}
                          placeholder={spec.placeholder || spec.key}
                          bind:value={installEnvValues[spec.key]}
                        />
                      </div>
                    {/each}
                    {#if installError}
                      <div class="install-error">{installError}</div>
                    {/if}
                    <div class="install-actions">
                      <button class="btn btn-sm btn-primary" onclick={handleInstall} disabled={actionInProgress === entry.id}>
                        {actionInProgress === entry.id ? 'Installing...' : 'Install'}
                      </button>
                      <button class="btn btn-sm" onclick={closeInstallForm}>Cancel</button>
                    </div>
                  </div>
                {:else}
                  <div class="catalog-footer">
                    <Badge>{entry.transport}</Badge>
                    <button class="btn btn-sm btn-primary" onclick={() => openInstallForm(entry)} disabled={!!actionInProgress}>
                      Install
                    </button>
                  </div>
                {/if}
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    </div>

    <!-- ── Registry Search ────────────────── -->
    <div class="section">
      <h2 class="section-title">Search Registry</h2>
      <p class="section-hint">Search the official MCP registry for additional servers. Requires manual configuration.</p>
      <div class="search-bar">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input class="input search-input" type="text" placeholder="Search MCP registry (min 3 chars)..." bind:value={searchQuery} oninput={onSearchInput} />
        {#if searching}
          <span class="searching-label"><span class="spinner" style="width:12px;height:12px;border-width:2px;"></span></span>
        {/if}
      </div>

      {#if marketplaceResults.length > 0}
        <div class="marketplace-list">
          {#each marketplaceResults as entry}
            <div class="card marketplace-card">
              <div class="marketplace-header">
                <h3 class="marketplace-name">{entry.name}</h3>
              </div>
              <p class="marketplace-desc">{entry.description || 'No description'}</p>
              <div class="marketplace-meta">
                {#if entry.package}
                  <code class="marketplace-pkg">{entry.package}</code>
                {/if}
                {#if entry.transport}
                  <Badge>{entry.transport}</Badge>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {:else if searchQuery.trim().length >= 3 && !searching}
        <div class="empty-state">No servers found</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .mcp-page { max-width: 1000px; }
  .page-header { margin-bottom: 24px; }
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.3px; }
  .page-desc { color: var(--text-muted); font-size: 14px; }
  .loading { color: var(--text-muted); padding: 40px 0; display: flex; align-items: center; gap: 10px; }
  .section { margin-bottom: 32px; }
  .section-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  .section-count { font-size: 12px; color: var(--text-muted); background: var(--bg-raised); padding: 2px 8px; border-radius: 10px; font-weight: 500; }
  .section-hint { font-size: 13px; color: var(--text-muted); margin-bottom: 12px; }
  .empty-state { padding: 28px; text-align: center; color: var(--text-muted); font-size: 13px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }

  /* Installed servers */
  .server-list { display: flex; flex-direction: column; gap: 12px; }
  .server-card { padding: 18px 22px; }
  .server-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
  .server-name { font-size: 14px; font-weight: 600; font-family: var(--font-mono); color: var(--tool); }
  .server-status-msg { font-size: 12px; color: var(--text-secondary); margin-top: 3px; display: flex; align-items: center; gap: 6px; }
  .server-error { font-size: 12px; color: var(--error, #ef4444); margin-top: 3px; word-break: break-word; }
  .server-tools { font-size: 12px; color: var(--text-muted); margin-top: 4px; display: flex; gap: 6px; }
  .tools-count { color: var(--text-secondary); font-weight: 500; }
  .tools-names { color: var(--text-muted); }
  .server-actions { display: flex; gap: 8px; flex-wrap: wrap; }

  /* Env editor */
  .env-editor { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
  .env-editor-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; color: var(--text-secondary); }
  .env-fields { display: flex; gap: 10px; margin-bottom: 10px; }
  .env-field { display: flex; flex-direction: column; gap: 4px; flex: 1; margin-bottom: 8px; }
  .env-label { font-size: 12px; font-weight: 500; color: var(--text-secondary); }
  .env-label .required { color: var(--error, #ef4444); }
  .env-configured { font-size: 10px; color: var(--success, #22c55e); font-weight: 400; margin-left: 4px; }
  .env-actions { display: flex; gap: 8px; }
  .input-sm { padding: 6px 10px; font-size: 13px; }

  /* Catalog */
  .category-title { font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: capitalize; margin-bottom: 10px; margin-top: 4px; }
  .catalog-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .catalog-card { padding: 16px 20px; display: flex; flex-direction: column; }
  .catalog-card.installed { opacity: 0.6; }
  .catalog-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .catalog-name { font-size: 14px; font-weight: 600; }
  .catalog-desc { font-size: 13px; color: var(--text-secondary); margin-bottom: 12px; line-height: 1.4; flex: 1; }
  .catalog-footer { display: flex; justify-content: space-between; align-items: center; }

  /* Install form */
  .install-form { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
  .install-actions { display: flex; gap: 8px; margin-top: 4px; }
  .install-error { font-size: 12px; color: var(--error, #ef4444); margin: 4px 0; }
  .help-link { font-size: 11px; color: var(--link, #60a5fa); text-decoration: none; margin-left: 4px; }
  .help-link:hover { text-decoration: underline; }

  /* Search */
  .search-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; position: relative; }
  .search-icon { position: absolute; left: 12px; color: var(--text-muted); pointer-events: none; z-index: 1; }
  .search-input { padding-left: 36px; }
  .searching-label { display: flex; align-items: center; flex-shrink: 0; }
  .marketplace-list { display: flex; flex-direction: column; gap: 12px; }
  .marketplace-card { padding: 16px 22px; }
  .marketplace-header { margin-bottom: 6px; }
  .marketplace-name { font-size: 14px; font-weight: 600; }
  .marketplace-desc { font-size: 13px; color: var(--text-secondary); margin-bottom: 8px; }
  .marketplace-meta { display: flex; align-items: center; gap: 8px; }
  .marketplace-pkg { font-size: 11px; font-family: var(--font-mono); color: var(--text-muted); background: var(--bg-raised); padding: 2px 6px; border-radius: var(--radius-sm); }

  @media (max-width: 768px) {
    .page-title { font-size: 20px; }
    .catalog-grid { grid-template-columns: 1fr; }
    .server-header { flex-direction: column; gap: 8px; }
    .server-actions { flex-wrap: wrap; }
    .env-fields { flex-direction: column; }
  }
</style>
