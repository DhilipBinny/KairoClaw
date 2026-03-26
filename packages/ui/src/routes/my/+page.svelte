<script lang="ts">
  import { onMount } from 'svelte';
  import { getMyDashboard } from '$lib/api';

  let data: { user: { id: string; name: string; role: string }; sessions: number; usage: { tokens: number; cost: number } } | null = $state(null);
  let loading = $state(true);

  onMount(async () => {
    try {
      data = await getMyDashboard();
    } catch { /* ignore */ }
    finally { loading = false; }
  });
</script>

<svelte:head><title>My Dashboard - Kairo</title></svelte:head>

<h1 class="page-title">Dashboard</h1>

{#if loading}
  <span class="spinner"></span>
{:else if data}
  <p class="greeting">Welcome back, <strong>{data.user.name}</strong></p>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">{data.sessions}</div>
      <div class="stat-label">Sessions</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{(data.usage.tokens / 1000).toFixed(1)}K</div>
      <div class="stat-label">Tokens Used (30d)</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${data.usage.cost.toFixed(2)}</div>
      <div class="stat-label">Cost (30d)</div>
    </div>
  </div>
{/if}

<style>
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  .greeting { color: var(--text-secondary); margin-bottom: 24px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
  .stat-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    padding: 20px;
  }
  .stat-value { font-size: 28px; font-weight: 700; color: var(--text-primary); }
  .stat-label { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
</style>
