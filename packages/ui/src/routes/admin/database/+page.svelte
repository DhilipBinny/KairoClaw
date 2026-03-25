<script lang="ts">
  import { onMount } from 'svelte';
  import { getDatabaseStatus, migrateDatabase } from '$lib/api';
  import Badge from '$lib/components/Badge.svelte';

  interface DbStatus {
    type: 'sqlite' | 'postgres';
    url?: string;
    counts: Record<string, number>;
    migration?: {
      available: boolean;
      alreadyMigrated: boolean;
      sqlitePath: string | null;
      sqliteSize: number | null;
      sqliteCounts: Record<string, number> | null;
    } | null;
  }

  let status = $state<DbStatus | null>(null);
  let loading = $state(true);
  let migrating = $state(false);
  let migrateResult = $state<{ success: boolean; migrated?: Record<string, number>; error?: string } | null>(null);

  async function loadStatus() {
    loading = true;
    try {
      status = await getDatabaseStatus() as unknown as DbStatus;
    } catch (e) {
      console.error('Failed to load database status:', e);
    } finally {
      loading = false;
    }
  }

  async function handleMigrate() {
    if (!confirm('Migrate all data from SQLite to PostgreSQL?\n\nThis will:\n- Copy all sessions, messages, and data to PostgreSQL\n- Rename gateway.db to gateway.db.migrated (backup)\n\nThe app will continue running during migration.')) return;

    migrating = true;
    migrateResult = null;
    try {
      const result = await migrateDatabase() as any;
      migrateResult = result;
      await loadStatus(); // Refresh
    } catch (e: any) {
      migrateResult = { success: false, error: e?.message || 'Migration failed' };
    } finally {
      migrating = false;
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function totalRows(counts: Record<string, number>): number {
    return Object.values(counts).reduce((a, b) => a + b, 0);
  }

  onMount(loadStatus);
</script>

<svelte:head>
  <title>Database - Admin - Kairo</title>
</svelte:head>

<div class="db-page">
  <div class="page-header">
    <h1 class="page-title">Database</h1>
    <p class="page-desc">View database status and manage data migration.</p>
  </div>

  {#if loading}
    <div class="loading"><span class="spinner"></span> Loading...</div>
  {:else if status}

    <!-- Current database -->
    <div class="section">
      <h2 class="section-title">Current Database</h2>
      <div class="card info-card">
        <div class="info-row">
          <span class="info-label">Type</span>
          <Badge variant={status.type === 'postgres' ? 'green' : 'default'}>{status.type === 'postgres' ? 'PostgreSQL' : 'SQLite'}</Badge>
        </div>
        {#if status.url}
          <div class="info-row">
            <span class="info-label">Connection</span>
            <code class="info-value mono">{status.url}</code>
          </div>
        {/if}
        <div class="info-row">
          <span class="info-label">Data</span>
          <span class="info-value">
            {status.counts.sessions || 0} sessions,
            {status.counts.messages || 0} messages,
            {status.counts.tool_calls || 0} tool calls,
            {status.counts.usage_records || 0} usage records
          </span>
        </div>
        <div class="info-row">
          <span class="info-label">Total rows</span>
          <span class="info-value">{totalRows(status.counts).toLocaleString()}</span>
        </div>
      </div>
    </div>

    <!-- Migration available (shouldn't normally show — auto-migration handles it on startup) -->
    {#if status.migration?.available}
      <div class="section">
        <h2 class="section-title">SQLite Data Available</h2>
        <div class="card migrate-card">
          <p class="migrate-desc">
            A SQLite database was found but hasn't been migrated yet.
            This usually migrates automatically on startup. You can trigger it manually.
          </p>

          {#if status.migration.sqliteCounts}
            <div class="migrate-preview">
              <h4 class="preview-title">Data to migrate</h4>
              {#if status.migration.sqliteSize}
                <div class="preview-row">
                  <span>SQLite file size</span>
                  <span>{formatBytes(status.migration.sqliteSize)}</span>
                </div>
              {/if}
              {#each Object.entries(status.migration.sqliteCounts).filter(([, v]) => v > 0) as [table, count]}
                <div class="preview-row">
                  <span>{table}</span>
                  <span>{count} rows</span>
                </div>
              {/each}
              <div class="preview-row preview-total">
                <span>Total</span>
                <span>{totalRows(status.migration.sqliteCounts).toLocaleString()} rows</span>
              </div>
            </div>
          {/if}

          {#if migrateResult}
            {#if migrateResult.success}
              <div class="result success">
                Migration complete! Restart the server to apply.
              </div>
            {:else}
              <div class="result error">{migrateResult.error}</div>
            {/if}
          {/if}

          <button
            class="btn btn-primary"
            onclick={handleMigrate}
            disabled={migrating}
          >
            {migrating ? 'Migrating...' : 'Migrate Now'}
          </button>
        </div>
      </div>
    {/if}

    <!-- Already migrated -->
    {#if status.migration?.alreadyMigrated}
      <div class="section">
        <div class="card info-card">
          <div class="result success">
            SQLite data has been migrated to PostgreSQL. Backup saved as <code>gateway.db.migrated</code>.
          </div>
        </div>
      </div>
    {/if}

    <!-- SQLite info (when not using PG) -->
    {#if status.type === 'sqlite'}
      <div class="section">
        <div class="card info-card">
          <p class="migrate-desc">
            To use PostgreSQL, set the <code>AGW_DATABASE_URL</code> environment variable and restart.
          </p>
          <code class="env-example">AGW_DATABASE_URL=postgres://user:pass@host:5432/kairoclaw</code>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .db-page { max-width: 800px; }
  .page-header { margin-bottom: 24px; }
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.3px; }
  .page-desc { color: var(--text-muted); font-size: 14px; }
  .loading { color: var(--text-muted); padding: 40px 0; display: flex; align-items: center; gap: 10px; }
  .section { margin-bottom: 24px; }
  .section-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
  .info-card { padding: 20px; }
  .info-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); }
  .info-row:last-child { border-bottom: none; }
  .info-label { font-size: 13px; color: var(--text-muted); font-weight: 500; }
  .info-value { font-size: 13px; color: var(--text-secondary); }
  .mono { font-family: var(--font-mono); font-size: 12px; }
  .migrate-card { padding: 20px; }
  .migrate-desc { font-size: 14px; color: var(--text-secondary); margin-bottom: 16px; }
  .migrate-note { font-size: 12px; color: var(--text-muted); margin: 12px 0; }
  .migrate-note code { background: var(--bg-raised); padding: 1px 4px; border-radius: 3px; font-size: 11px; }
  .migrate-preview { margin-bottom: 16px; }
  .preview-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: var(--text-secondary); }
  .preview-row { display: flex; justify-content: space-between; font-size: 13px; padding: 4px 0; color: var(--text-muted); }
  .preview-total { font-weight: 600; color: var(--text-primary); border-top: 1px solid var(--border); padding-top: 8px; margin-top: 4px; }
  .result { padding: 10px 14px; border-radius: var(--radius-md); font-size: 13px; margin-bottom: 12px; }
  .result.success { background: rgba(34, 197, 94, 0.1); color: var(--success, #22c55e); }
  .result.error { background: rgba(239, 68, 68, 0.1); color: var(--error, #ef4444); }
  .env-example { display: block; font-size: 12px; background: var(--bg-raised); padding: 10px 14px; border-radius: var(--radius-md); margin-top: 8px; word-break: break-all; }
</style>
