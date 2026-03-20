<script lang="ts">
  import { onMount } from 'svelte';
  import { getHealth } from '$lib/api';
  import { getSystemInfo, runDoctor } from '$lib/api';
  import Badge from '$lib/components/Badge.svelte';

  interface HealthData {
    status: string;
    version: string;
    uptime: number;
    model: string;
  }

  interface SystemData {
    uptime: number;
    nodeVersion: string;
    platform: string;
    hostname: string;
    cpus: number;
    memory: { rssFormatted: string; heapUsedFormatted: string };
    osMemory: { totalFormatted: string; freeFormatted: string };
  }

  interface DoctorResult {
    overall: string;
    checks: Array<{ name: string; status: string; message: string }>;
  }

  let health: HealthData | null = $state(null);
  let system: SystemData | null = $state(null);
  let doctor: DoctorResult | null = $state(null);
  let loading = $state(true);

  function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  function statusVariant(status: string): 'green' | 'yellow' | 'red' | 'default' {
    switch (status) {
      case 'ok': case 'healthy': return 'green';
      case 'warn': case 'degraded': return 'yellow';
      case 'error': case 'unhealthy': return 'red';
      default: return 'default';
    }
  }

  onMount(async () => {
    try {
      const [h, s, d] = await Promise.all([
        getHealth(),
        getSystemInfo().catch(() => null),
        runDoctor().catch(() => null),
      ]);
      health = h;
      system = s as SystemData | null;
      doctor = d;
    } catch (e) {
      console.error('Dashboard load error:', e);
    } finally {
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>Admin Dashboard - Kairo</title>
</svelte:head>

<div class="dashboard">
  <div class="dashboard-header">
    <h1 class="page-title">Dashboard</h1>
    <p class="page-desc">System overview and health status</p>
  </div>

  {#if loading}
    <div class="loading">
      <span class="spinner"></span>
      Loading dashboard...
    </div>
  {:else}
    <!-- Status cards -->
    <div class="stat-grid">
      <div class="card stat-card stat-status">
        <div class="stat-icon-wrap stat-icon-green">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
          </svg>
        </div>
        <div class="stat-content">
          <div class="stat-label">Status</div>
          <div class="stat-value">
            <Badge variant={health?.status === 'ok' ? 'green' : 'red'}>
              {health?.status || 'unknown'}
            </Badge>
          </div>
        </div>
      </div>

      <div class="card stat-card stat-uptime">
        <div class="stat-icon-wrap stat-icon-blue">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
        </div>
        <div class="stat-content">
          <div class="stat-label">Uptime</div>
          <div class="stat-value">{health ? formatUptime(health.uptime) : '--'}</div>
        </div>
      </div>

      <div class="card stat-card stat-model">
        <div class="stat-icon-wrap stat-icon-purple">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
            <path d="M2 17l10 5 10-5"></path>
            <path d="M2 12l10 5 10-5"></path>
          </svg>
        </div>
        <div class="stat-content">
          <div class="stat-label">Model</div>
          <div class="stat-value stat-model-name">{health?.model || '--'}</div>
        </div>
      </div>

      <div class="card stat-card stat-version">
        <div class="stat-icon-wrap stat-icon-accent">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 18 22 12 16 6"></polyline>
            <polyline points="8 6 2 12 8 18"></polyline>
          </svg>
        </div>
        <div class="stat-content">
          <div class="stat-label">Version</div>
          <div class="stat-value">{health?.version || '--'}</div>
        </div>
      </div>
    </div>

    <!-- System info -->
    {#if system}
      <div class="section">
        <h2 class="section-title">System</h2>
        <div class="stat-grid stat-grid-sm">
          <div class="card stat-card-sm">
            <div class="stat-label">Platform</div>
            <div class="stat-value-sm">{system.platform}</div>
          </div>
          <div class="card stat-card-sm">
            <div class="stat-label">Node.js</div>
            <div class="stat-value-sm">{system.nodeVersion}</div>
          </div>
          <div class="card stat-card-sm">
            <div class="stat-label">Memory (RSS)</div>
            <div class="stat-value-sm">{system.memory.rssFormatted}</div>
          </div>
          <div class="card stat-card-sm">
            <div class="stat-label">CPUs</div>
            <div class="stat-value-sm">{system.cpus}</div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Doctor checks -->
    {#if doctor}
      <div class="section">
        <h2 class="section-title">
          Health Checks
          <Badge variant={statusVariant(doctor.overall)}>{doctor.overall}</Badge>
        </h2>
        <div class="checks-list">
          {#each doctor.checks as check}
            <div class="check-row">
              <div class="check-status">
                <Badge variant={statusVariant(check.status)}>{check.status}</Badge>
              </div>
              <span class="check-name">{check.name}</span>
              <span class="check-msg">{check.message}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .dashboard {
    max-width: 1000px;
  }
  .dashboard-header {
    margin-bottom: 28px;
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
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
    margin-bottom: 28px;
  }
  .stat-grid-sm {
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  }
  .stat-card {
    padding: 20px;
    display: flex;
    gap: 16px;
    align-items: flex-start;
    transition: border-color var(--duration) var(--ease), box-shadow var(--duration) var(--ease);
  }
  .stat-card:hover {
    border-color: var(--border);
  }
  .stat-icon-wrap {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .stat-icon-green {
    background: rgba(52, 211, 153, 0.1);
    color: var(--green);
  }
  .stat-icon-blue {
    background: rgba(56, 189, 248, 0.1);
    color: var(--blue);
  }
  .stat-icon-purple {
    background: var(--cost-subtle);
    color: var(--cost);
  }
  .stat-icon-accent {
    background: var(--accent-subtle);
    color: var(--accent);
  }
  .stat-content {
    flex: 1;
    min-width: 0;
  }
  .stat-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
  }
  .stat-value {
    font-size: 20px;
    font-weight: 600;
  }
  .stat-model-name {
    font-size: 13px;
    font-family: var(--font-mono);
    word-break: break-all;
  }
  .stat-card-sm {
    padding: 14px 18px;
  }
  .stat-value-sm {
    font-size: 14px;
    font-weight: 600;
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
    gap: 10px;
  }
  .checks-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .check-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
    transition: border-color var(--duration) var(--ease);
  }
  .check-row:hover {
    border-color: var(--border);
  }
  .check-status {
    flex-shrink: 0;
  }
  .check-name {
    font-weight: 500;
    min-width: 140px;
  }
  .check-msg {
    color: var(--text-secondary);
    word-break: break-all;
  }
</style>
