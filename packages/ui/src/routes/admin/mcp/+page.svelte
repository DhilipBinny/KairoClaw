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
    transport: string;
    installed: boolean;
    enabled: boolean;
    envVars?: EnvVarSpec[];
    envVarsResolved?: Record<string, boolean>;
  }

  interface MarketplaceEntry {
    id: string;
    name: string;
    description: string;
    qualifiedName: string;
  }

  let servers: MCPServer[] = $state([]);
  let catalog: CatalogEntry[] = $state([]);
  let marketplaceResults: MarketplaceEntry[] = $state([]);
  let searchQuery = $state('');
  let loading = $state(true);
  let searching = $state(false);
  let actionInProgress = $state('');

  // Env var editor state
  let envEditorOpen = $state<string | null>(null);
  let envEditorValues = $state<Record<string, string>>({});

  // Catalog install form state
  let installFormOpen = $state<string | null>(null);
  let installFormValues = $state<Record<string, string>>({});

  // Polling
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function hasTransitionalServers(): boolean {
    return servers.some(s => s.status === 'installing' || s.status === 'connecting');
  }

  function startPolling() {
    stopPolling();
    if (hasTransitionalServers()) {
      pollTimer = setInterval(async () => {
        await loadServersOnly();
        if (!hasTransitionalServers()) {
          stopPolling();
        }
      }, 3000);
    }
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function loadServersOnly() {
    try {
      const serversData = await getMCPServers().catch(() => ({ servers: [] }));
      const rawServers = (serversData as any).servers;
      if (Array.isArray(rawServers)) {
        servers = rawServers;
      } else if (rawServers && typeof rawServers === 'object') {
        servers = Object.entries(rawServers).map(([id, s]: [string, any]) => ({ id, ...s }));
      } else {
        servers = [];
      }
    } catch (e) {
      console.error('Failed to load servers:', e);
    }
  }

  async function loadData() {
    loading = true;
    try {
      const [serversData, catalogData] = await Promise.all([
        getMCPServers().catch(() => ({ servers: [] })),
        getMCPCatalog().catch(() => ({ catalog: [] })),
      ]);
      const rawServers = (serversData as any).servers;
      if (Array.isArray(rawServers)) {
        servers = rawServers;
      } else if (rawServers && typeof rawServers === 'object') {
        servers = Object.entries(rawServers).map(([id, s]: [string, any]) => ({ id, ...s }));
      } else {
        servers = [];
      }
      catalog = catalogData.catalog || [];
    } catch (e) {
      console.error('Failed to load MCP data:', e);
    } finally {
      loading = false;
      startPolling();
    }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) {
      marketplaceResults = [];
      return;
    }
    searching = true;
    try {
      const data = await searchMCPMarketplace(searchQuery);
      marketplaceResults = data.servers || [];
    } catch (e) {
      console.error('Search failed:', e);
    } finally {
      searching = false;
    }
  }

  function openInstallForm(entry: CatalogEntry) {
    // Only show form if there are required env vars that aren't already resolved
    const hasUnresolved = entry.envVars && entry.envVars.some(v =>
      v.required && !(entry.envVarsResolved?.[v.key])
    );
    if (hasUnresolved) {
      installFormOpen = entry.id;
      installFormValues = {};
      for (const v of entry.envVars!) {
        installFormValues[v.key] = '';
      }
    } else {
      handleInstallCatalog(entry);
    }
  }

  async function handleInstallWithEnv(entry: CatalogEntry) {
    actionInProgress = entry.id;
    try {
      await installMCPServer({ id: entry.id, env: installFormValues });
      installFormOpen = null;
      installFormValues = {};
      await loadData();
    } catch (e) {
      console.error('Install failed:', e);
    } finally {
      actionInProgress = '';
    }
  }

  async function handleInstallCatalog(entry: CatalogEntry) {
    actionInProgress = entry.id;
    try {
      await installMCPServer({ id: entry.id });
      await loadData();
    } catch (e) {
      console.error('Install failed:', e);
    } finally {
      actionInProgress = '';
    }
  }

  async function handleRemove(id: string) {
    actionInProgress = id;
    try {
      await removeMCPServer(id);
      await loadData();
    } catch (e) {
      console.error('Remove failed:', e);
    } finally {
      actionInProgress = '';
    }
  }

  async function handleToggle(id: string, currentStatus: string) {
    actionInProgress = `toggle-${id}`;
    try {
      if (currentStatus === 'connected' || currentStatus === 'connecting' || currentStatus === 'installing') {
        await disableMCPServer(id);
      } else {
        await enableMCPServer(id);
      }
      await loadData();
    } catch (e) {
      console.error('Toggle failed:', e);
    } finally {
      actionInProgress = '';
    }
  }

  async function handleReconnect(id: string) {
    actionInProgress = `reconnect-${id}`;
    try {
      await reconnectMCPServer(id);
      await loadData();
    } catch (e) {
      console.error('Reconnect failed:', e);
    } finally {
      actionInProgress = '';
    }
  }

  function toggleEnvEditor(server: MCPServer) {
    if (envEditorOpen === server.id) {
      envEditorOpen = null;
      envEditorValues = {};
    } else {
      envEditorOpen = server.id;
      // Pre-populate with existing keys (values masked — user must re-enter to change)
      envEditorValues = {};
      if (server.envKeys) {
        for (const key of server.envKeys) {
          envEditorValues[key] = '';
        }
      }
    }
  }

  async function handleSaveEnv(id: string) {
    actionInProgress = `env-${id}`;
    try {
      // Strip internal _-prefixed keys and empty values (keep current for those)
      const cleanEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(envEditorValues)) {
        if (!k.startsWith('_') && v !== '') cleanEnv[k] = v;
      }
      if (Object.keys(cleanEnv).length > 0) {
        await updateMCPServer(id, { env: cleanEnv });
      }
      envEditorOpen = null;
      envEditorValues = {};
      await loadData();
    } catch (e) {
      console.error('Save env failed:', e);
    } finally {
      actionInProgress = '';
    }
  }

  function serverStatusVariant(status: string): 'green' | 'yellow' | 'red' | 'default' {
    if (status === 'connected') return 'green';
    if (status === 'installing' || status === 'connecting') return 'yellow';
    if (status === 'error' || status === 'disconnected') return 'red';
    return 'default';
  }

  let searchTimeout: ReturnType<typeof setTimeout>;
  function onSearchInput() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(handleSearch, 400);
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
    <!-- Installed servers -->
    <div class="section">
      <h2 class="section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--tool)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
          <line x1="6" y1="6" x2="6.01" y2="6"></line>
          <line x1="6" y1="18" x2="6.01" y2="18"></line>
        </svg>
        Installed Servers
        <span class="section-count">{servers.length}</span>
      </h2>
      {#if servers.length === 0}
        <div class="empty-state">No MCP servers installed yet.</div>
      {:else}
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
                  {#if server.tools && server.tools.length > 0}
                    <div class="server-tools">
                      <span class="tools-count">{server.tools.length} tool{server.tools.length !== 1 ? 's' : ''}</span>
                      <span class="tools-names">{server.tools.slice(0, 5).join(', ')}{server.tools.length > 5 ? '...' : ''}</span>
                    </div>
                  {/if}
                </div>
                <Badge variant={serverStatusVariant(server.status)}>{server.status}</Badge>
              </div>
              <div class="server-actions">
                <button
                  class="btn btn-sm"
                  onclick={() => handleToggle(server.id, server.status)}
                  disabled={actionInProgress === `toggle-${server.id}` || server.status === 'installing'}
                >
                  {actionInProgress === `toggle-${server.id}` ? '...' : (server.status === 'connected' || server.status === 'connecting' || server.status === 'installing') ? 'Disable' : 'Enable'}
                </button>
                <button
                  class="btn btn-sm"
                  onclick={() => handleReconnect(server.id)}
                  disabled={actionInProgress === `reconnect-${server.id}` || server.status === 'installing'}
                >
                  {actionInProgress === `reconnect-${server.id}` ? '...' : 'Reconnect'}
                </button>
                <button
                  class="btn btn-sm"
                  onclick={() => toggleEnvEditor(server)}
                >
                  Env{server.envKeys && server.envKeys.length > 0 ? ` (${server.envKeys.length})` : ''}
                </button>
                <button
                  class="btn btn-sm btn-danger"
                  onclick={() => handleRemove(server.id)}
                  disabled={actionInProgress === server.id}
                >
                  {actionInProgress === server.id ? '...' : 'Remove'}
                </button>
              </div>

              <!-- Env var editor (expandable) -->
              {#if envEditorOpen === server.id}
                <div class="env-editor">
                  <h4 class="env-editor-title">Environment Variables</h4>
                  <!-- Existing configured keys -->
                  {#each Object.entries(envEditorValues).filter(([k]) => !k.startsWith('_')) as [key]}
                    <div class="env-field">
                      <label class="env-label">
                        {key}
                        {#if server.envKeys?.includes(key)}
                          <span class="env-configured">configured</span>
                        {/if}
                      </label>
                      <input
                        class="input input-sm"
                        type="password"
                        placeholder={server.envKeys?.includes(key) ? '(leave empty to keep current)' : 'enter value'}
                        bind:value={envEditorValues[key]}
                      />
                    </div>
                  {/each}
                  <!-- Add new key -->
                  <div class="env-fields">
                    <div class="env-field">
                      <label class="env-label">New Key</label>
                      <input
                        class="input input-sm"
                        type="text"
                        placeholder="ENV_KEY"
                        bind:value={envEditorValues._newKey}
                      />
                    </div>
                    <div class="env-field">
                      <label class="env-label">Value</label>
                      <input
                        class="input input-sm"
                        type="password"
                        placeholder="value"
                        bind:value={envEditorValues._newValue}
                      />
                    </div>
                  </div>
                  <div class="env-actions">
                    <button
                      class="btn btn-sm"
                      onclick={() => {
                        if (envEditorValues._newKey) {
                          const key = envEditorValues._newKey;
                          const val = envEditorValues._newValue || '';
                          envEditorValues[key] = val;
                          envEditorValues._newKey = '';
                          envEditorValues._newValue = '';
                          envEditorValues = { ...envEditorValues };
                        }
                      }}
                    >
                      Add
                    </button>
                    <button
                      class="btn btn-sm btn-primary"
                      onclick={() => handleSaveEnv(server.id)}
                      disabled={actionInProgress === `env-${server.id}`}
                    >
                      {actionInProgress === `env-${server.id}` ? 'Saving...' : 'Save & Reconnect'}
                    </button>
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Catalog -->
    <div class="section">
      <h2 class="section-title">Curated Catalog</h2>
      <div class="catalog-grid">
        {#each catalog as entry}
          <div class="card catalog-card">
            <div class="catalog-header">
              <h3 class="catalog-name">{entry.name || entry.id}</h3>
              {#if entry.installed}
                <Badge variant="green">Installed</Badge>
              {/if}
            </div>
            <p class="catalog-desc">{entry.description || 'No description'}</p>

            <!-- Install form with env vars -->
            {#if installFormOpen === entry.id && entry.envVars}
              <div class="install-form">
                {#each entry.envVars as spec}
                  <div class="env-field">
                    <label class="env-label">
                      {spec.label}
                      {#if spec.required}<span class="required">*</span>{/if}
                    </label>
                    <input
                      class="input input-sm"
                      type={spec.sensitive ? 'password' : 'text'}
                      placeholder={spec.placeholder || spec.key}
                      bind:value={installFormValues[spec.key]}
                    />
                  </div>
                {/each}
                <div class="install-form-actions">
                  <button
                    class="btn btn-sm btn-primary"
                    onclick={() => handleInstallWithEnv(entry)}
                    disabled={actionInProgress === entry.id}
                  >
                    {actionInProgress === entry.id ? 'Installing...' : 'Install'}
                  </button>
                  <button
                    class="btn btn-sm"
                    onclick={() => { installFormOpen = null; installFormValues = {}; }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            {:else}
              <div class="catalog-footer">
                <Badge>{entry.transport}</Badge>
                {#if !entry.installed}
                  <button
                    class="btn btn-sm btn-primary"
                    onclick={() => openInstallForm(entry)}
                    disabled={actionInProgress === entry.id}
                  >
                    {actionInProgress === entry.id ? 'Installing...' : 'Install'}
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        {:else}
          <div class="empty-state">No catalog entries.</div>
        {/each}
      </div>
    </div>

    <!-- Marketplace search -->
    <div class="section">
      <h2 class="section-title">Marketplace Search</h2>
      <div class="search-bar">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          class="input search-input"
          type="text"
          placeholder="Search MCP registry..."
          bind:value={searchQuery}
          oninput={onSearchInput}
        />
        {#if searching}
          <span class="searching-label"><span class="spinner" style="width:12px;height:12px;border-width:2px;"></span></span>
        {/if}
      </div>

      {#if marketplaceResults.length > 0}
        <div class="marketplace-list">
          {#each marketplaceResults as entry}
            <div class="card marketplace-card">
              <div class="marketplace-header">
                <h3 class="marketplace-name">{entry.name || entry.qualifiedName}</h3>
              </div>
              <p class="marketplace-desc">{entry.description || 'No description'}</p>
              <div class="marketplace-meta">
                <code class="marketplace-qn">{entry.qualifiedName}</code>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .mcp-page {
    max-width: 1000px;
  }
  .page-header {
    margin-bottom: 24px;
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
  .loading {
    color: var(--text-muted);
    padding: 40px 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .section {
    margin-bottom: 32px;
  }
  .section-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-count {
    font-size: 12px;
    color: var(--text-muted);
    background: var(--bg-raised);
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 500;
  }
  .empty-state {
    padding: 28px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .server-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .server-card {
    padding: 18px 22px;
    transition: border-color var(--duration) var(--ease);
  }
  .server-card:hover {
    border-color: rgba(255, 255, 255, 0.1);
  }
  .server-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 12px;
  }
  .server-name {
    font-size: 14px;
    font-weight: 600;
    font-family: var(--font-mono);
    color: var(--tool);
  }
  .server-status-msg {
    font-size: 12px;
    color: var(--text-secondary);
    margin-top: 3px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .server-error {
    font-size: 12px;
    color: var(--error, #ef4444);
    margin-top: 3px;
    word-break: break-word;
  }
  .server-tools {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
    display: flex;
    gap: 6px;
  }
  .tools-count {
    color: var(--text-secondary);
    font-weight: 500;
  }
  .tools-names {
    color: var(--text-muted);
  }
  .server-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .env-editor {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .env-editor-title {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 10px;
    color: var(--text-secondary);
  }
  .env-fields {
    display: flex;
    gap: 10px;
    margin-bottom: 10px;
  }
  .env-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    margin-bottom: 8px;
  }
  .env-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
  }
  .env-label .required {
    color: var(--error, #ef4444);
  }
  .env-configured {
    font-size: 10px;
    color: var(--success, #22c55e);
    font-weight: 400;
    margin-left: 4px;
  }
  .env-actions {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }
  .env-saved-row {
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    padding: 2px 0;
  }
  .install-form {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .install-form-actions {
    display: flex;
    gap: 8px;
  }
  .input-sm {
    padding: 6px 10px;
    font-size: 13px;
  }
  .catalog-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  }
  .catalog-card {
    padding: 18px 22px;
    display: flex;
    flex-direction: column;
    transition: border-color var(--duration) var(--ease);
  }
  .catalog-card:hover {
    border-color: rgba(255, 255, 255, 0.1);
  }
  .catalog-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .catalog-name {
    font-size: 14px;
    font-weight: 600;
  }
  .catalog-desc {
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 14px;
    line-height: 1.4;
    flex: 1;
  }
  .catalog-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .search-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    position: relative;
  }
  .search-icon {
    position: absolute;
    left: 12px;
    color: var(--text-muted);
    pointer-events: none;
    z-index: 1;
  }
  .search-input {
    padding-left: 36px;
  }
  .searching-label {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .marketplace-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .marketplace-card {
    padding: 16px 22px;
    transition: border-color var(--duration) var(--ease);
  }
  .marketplace-card:hover {
    border-color: rgba(255, 255, 255, 0.1);
  }
  .marketplace-header {
    margin-bottom: 6px;
  }
  .marketplace-name {
    font-size: 14px;
    font-weight: 600;
  }
  .marketplace-desc {
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 8px;
  }
  .marketplace-qn {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    background: var(--bg-raised);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
  }
</style>
