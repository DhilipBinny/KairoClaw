<script lang="ts">
  import { onMount } from 'svelte';
  import { getMyUsage } from '$lib/api';

  interface MyUsage {
    totalInput: number;
    totalOutput: number;
    totalCost: number;
    totalRequests: number;
    byModel: Array<{ model: string; input: number; output: number; cost: number; requests: number }>;
    byDay: Array<{ date: string; cost: number; requests: number }>;
  }

  let usage: MyUsage | null = $state(null);
  let loading = $state(true);
  let days = $state(30);

  async function loadUsage() {
    loading = true;
    try {
      usage = await getMyUsage(days) as unknown as MyUsage;
    } catch { /* ignore */ }
    finally { loading = false; }
  }

  function formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
    return tokens.toString();
  }

  function formatCost(cost: number): string {
    return `$${cost.toFixed(4)}`;
  }

  onMount(loadUsage);
</script>

<svelte:head><title>My Usage - Kairo</title></svelte:head>

<div class="usage-header">
  <div>
    <h1 class="page-title">My Usage</h1>
    <p class="subtitle">Track your token usage and costs.</p>
  </div>
  <select class="input" style="width: 140px;" bind:value={days} onchange={loadUsage}>
    <option value={7}>Last 7 days</option>
    <option value={30}>Last 30 days</option>
    <option value={90}>Last 90 days</option>
  </select>
</div>

{#if loading}
  <span class="spinner"></span>
{:else if usage}
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">${usage.totalCost.toFixed(2)}</div>
      <div class="stat-label">Estimated Cost</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{(usage.totalRequests || 0).toLocaleString()}</div>
      <div class="stat-label">Requests</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{formatTokens(usage.totalInput)}</div>
      <div class="stat-label">Input Tokens</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{formatTokens(usage.totalOutput)}</div>
      <div class="stat-label">Output Tokens</div>
    </div>
  </div>

  {#if usage.byModel && usage.byModel.length > 0}
    <h2 class="section-title">By Model</h2>
    <div class="model-table">
      <div class="model-header">
        <span>Model</span><span>Requests</span><span>Input</span><span>Output</span><span>Cost</span>
      </div>
      {#each usage.byModel as row}
        <div class="model-row">
          <span class="model-name">{row.model}</span>
          <span>{row.requests.toLocaleString()}</span>
          <span>{formatTokens(row.input)}</span>
          <span>{formatTokens(row.output)}</span>
          <span>{formatCost(row.cost)}</span>
        </div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .usage-header {
    display: flex; justify-content: space-between; align-items: flex-start;
    margin-bottom: 20px;
  }
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  .subtitle { color: var(--text-muted); font-size: 13px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius); padding: 16px; }
  .stat-value { font-size: 24px; font-weight: 700; }
  .stat-label { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
  .section-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
  .model-table { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius); overflow: hidden; }
  .model-header, .model-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 1fr; padding: 8px 14px; font-size: 12px; }
  .model-header { background: var(--bg-raised); font-weight: 600; color: var(--text-secondary); border-bottom: 1px solid var(--border-subtle); }
  .model-row { border-bottom: 1px solid var(--border-subtle); }
  .model-row:last-child { border-bottom: none; }
  .model-name { font-family: var(--font-mono, monospace); font-size: 12px; }

  @media (max-width: 768px) {
    .usage-header { flex-direction: column; gap: 12px; }
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    .model-table { overflow-x: auto; }
    .model-header, .model-row { min-width: 500px; }
  }
</style>
