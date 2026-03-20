<script lang="ts">
  import { onMount } from 'svelte';
  import { getUsage } from '$lib/api';

  interface UsageSummary {
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalRequests: number;
    byModel: Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      cost: number;
      requests: number;
    }>;
    byDay: Array<{
      date: string;
      cost: number;
      requests: number;
    }>;
  }

  let usage: UsageSummary | null = $state(null);
  let loading = $state(true);
  let days = $state(30);

  async function loadUsage() {
    loading = true;
    try {
      const data = await getUsage(days);
      usage = data as unknown as UsageSummary;
    } catch (e) {
      console.error('Failed to load usage:', e);
    } finally {
      loading = false;
    }
  }

  function formatCost(cost: number): string {
    return `$${cost.toFixed(4)}`;
  }

  function formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
    return tokens.toString();
  }

  onMount(loadUsage);
</script>

<svelte:head>
  <title>Usage - Admin - Kairo</title>
</svelte:head>

<div class="usage-page">
  <div class="usage-header">
    <div>
      <h1 class="page-title">Usage & Costs</h1>
      <p class="page-desc">Track token usage and costs across models.</p>
    </div>
    <div class="usage-controls">
      <select class="input" style="width: 140px;" bind:value={days} onchange={loadUsage}>
        <option value={7}>Last 7 days</option>
        <option value={30}>Last 30 days</option>
        <option value={90}>Last 90 days</option>
      </select>
    </div>
  </div>

  {#if loading}
    <div class="loading"><span class="spinner"></span> Loading usage data...</div>
  {:else if usage}
    <!-- Summary cards -->
    <div class="stat-grid">
      <div class="card stat-card stat-cost">
        <div class="stat-icon-wrap" style="background: var(--cost-subtle); color: var(--cost)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="1" x2="12" y2="23"></line>
            <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
          </svg>
        </div>
        <div>
          <div class="stat-label">Total Cost</div>
          <div class="stat-value stat-value-cost">{formatCost(usage.totalCost || 0)}</div>
        </div>
      </div>
      <div class="card stat-card">
        <div class="stat-icon-wrap" style="background: var(--accent-subtle); color: var(--accent)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
          </svg>
        </div>
        <div>
          <div class="stat-label">Total Requests</div>
          <div class="stat-value">{usage.totalRequests || 0}</div>
        </div>
      </div>
      <div class="card stat-card">
        <div class="stat-icon-wrap" style="background: var(--blue-subtle); color: var(--blue)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
        </div>
        <div>
          <div class="stat-label">Input Tokens</div>
          <div class="stat-value">{formatTokens(usage.totalInputTokens || 0)}</div>
        </div>
      </div>
      <div class="card stat-card">
        <div class="stat-icon-wrap" style="background: var(--green-subtle); color: var(--green)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        </div>
        <div>
          <div class="stat-label">Output Tokens</div>
          <div class="stat-value">{formatTokens(usage.totalOutputTokens || 0)}</div>
        </div>
      </div>
    </div>

    <!-- By model -->
    {#if usage.byModel && usage.byModel.length > 0}
      <div class="section">
        <h2 class="section-title">Usage by Model</h2>
        <div class="card table-card">
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Requests</th>
                  <th>Input Tokens</th>
                  <th>Output Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {#each usage.byModel as row}
                  <tr>
                    <td class="model-cell">{row.model}</td>
                    <td>{row.requests}</td>
                    <td>{formatTokens(row.inputTokens)}</td>
                    <td>{formatTokens(row.outputTokens)}</td>
                    <td class="cost-cell">{formatCost(row.cost)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    {/if}

    <!-- By day -->
    {#if usage.byDay && usage.byDay.length > 0}
      <div class="section">
        <h2 class="section-title">Daily Usage</h2>
        <div class="card chart-card">
          <div class="daily-chart">
            {#each usage.byDay as day}
              <div class="day-bar" title="{day.date}: {formatCost(day.cost)} ({day.requests} requests)">
                <div
                  class="day-fill"
                  style="height: {Math.max(4, (day.cost / Math.max(...usage.byDay.map(d => d.cost || 1))) * 100)}%"
                ></div>
                <div class="day-label">{day.date.slice(5)}</div>
              </div>
            {/each}
          </div>
        </div>
      </div>
    {/if}
  {:else}
    <div class="empty-state">No usage data available for the selected period.</div>
  {/if}
</div>

<style>
  .usage-page {
    max-width: 1000px;
  }
  .usage-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
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
  .loading, .empty-state {
    color: var(--text-muted);
    padding: 40px 0;
    text-align: center;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
    margin-bottom: 32px;
  }
  .stat-card {
    padding: 18px 22px;
    display: flex;
    gap: 14px;
    align-items: flex-start;
    transition: border-color var(--duration) var(--ease);
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
  .stat-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }
  .stat-value {
    font-size: 22px;
    font-weight: 700;
  }
  .stat-value-cost {
    color: var(--cost);
  }
  .section {
    margin-bottom: 32px;
  }
  .section-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 16px;
  }
  .table-card {
    padding: 0;
    overflow: hidden;
  }
  .table-wrapper {
    overflow-x: auto;
  }
  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .data-table th, .data-table td {
    padding: 11px 16px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .data-table th {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    background: var(--bg-raised);
  }
  .data-table tbody tr {
    transition: background var(--duration) var(--ease);
  }
  .data-table tbody tr:hover {
    background: var(--bg-raised);
  }
  .data-table tbody tr:last-child td {
    border-bottom: none;
  }
  .model-cell {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .cost-cell {
    color: var(--cost);
    font-weight: 500;
  }
  .chart-card {
    padding: 20px;
  }
  .daily-chart {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 120px;
    overflow-x: auto;
  }
  .day-bar {
    flex: 1;
    min-width: 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100%;
    position: relative;
  }
  .day-fill {
    width: 100%;
    max-width: 24px;
    background: linear-gradient(180deg, var(--accent), rgba(99, 102, 241, 0.4));
    border-radius: 3px 3px 0 0;
    margin-top: auto;
    transition: height 0.4s var(--ease);
  }
  .day-fill:hover {
    background: linear-gradient(180deg, var(--accent-hover), rgba(99, 102, 241, 0.6));
  }
  .day-label {
    position: absolute;
    bottom: -20px;
    font-size: 9px;
    color: var(--text-muted);
    white-space: nowrap;
  }
</style>
