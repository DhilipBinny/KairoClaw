<script lang="ts">
  import { onMount } from 'svelte';
  import { getMyUsage } from '$lib/api';

  let usage: { totalInput: number; totalOutput: number; totalCost: number; byModel: Record<string, { input: number; output: number; cost: number }> } | null = $state(null);
  let loading = $state(true);

  onMount(async () => {
    try {
      usage = await getMyUsage(30) as typeof usage;
    } catch { /* ignore */ }
    finally { loading = false; }
  });
</script>

<svelte:head><title>My Usage - Kairo</title></svelte:head>

<h1 class="page-title">My Usage</h1>
<p class="subtitle">Last 30 days</p>

{#if loading}
  <span class="spinner"></span>
{:else if usage}
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">{((usage.totalInput + usage.totalOutput) / 1000).toFixed(1)}K</div>
      <div class="stat-label">Total Tokens</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{(usage.totalInput / 1000).toFixed(1)}K</div>
      <div class="stat-label">Input Tokens</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{(usage.totalOutput / 1000).toFixed(1)}K</div>
      <div class="stat-label">Output Tokens</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${usage.totalCost.toFixed(2)}</div>
      <div class="stat-label">Estimated Cost</div>
    </div>
  </div>

  {#if Object.keys(usage.byModel).length > 0}
    <h2 class="section-title">By Model</h2>
    <div class="model-table">
      <div class="model-header">
        <span>Model</span><span>Input</span><span>Output</span><span>Cost</span>
      </div>
      {#each Object.entries(usage.byModel) as [model, stats]}
        <div class="model-row">
          <span class="model-name">{model}</span>
          <span>{(stats.input / 1000).toFixed(1)}K</span>
          <span>{(stats.output / 1000).toFixed(1)}K</span>
          <span>${stats.cost.toFixed(3)}</span>
        </div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  .subtitle { color: var(--text-muted); margin-bottom: 20px; font-size: 13px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius); padding: 16px; }
  .stat-value { font-size: 24px; font-weight: 700; }
  .stat-label { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
  .section-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
  .model-table { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius); overflow: hidden; }
  .model-header, .model-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; padding: 8px 14px; font-size: 12px; }
  .model-header { background: var(--bg-raised); font-weight: 600; color: var(--text-secondary); border-bottom: 1px solid var(--border-subtle); }
  .model-row { border-bottom: 1px solid var(--border-subtle); }
  .model-row:last-child { border-bottom: none; }
  .model-name { font-family: var(--font-mono, monospace); font-size: 12px; }
</style>
