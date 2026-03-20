<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    color?: 'green' | 'blue' | 'accent' | 'purple' | 'yellow' | 'red';
    children: Snippet;
  }

  let { label, color = 'accent', children }: Props = $props();
</script>

<div class="card stat-card">
  <div class="stat-icon-wrap stat-icon-{color}">
    <span class="stat-dot"></span>
  </div>
  <div class="stat-content">
    <div class="stat-label">{label}</div>
    <div class="stat-value">{@render children()}</div>
  </div>
</div>

<style>
  .stat-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
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
  .stat-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: currentColor;
  }
  .stat-icon-green {
    background: var(--green-subtle);
    color: var(--green);
  }
  .stat-icon-blue {
    background: var(--blue-subtle);
    color: var(--blue);
  }
  .stat-icon-accent {
    background: var(--accent-subtle);
    color: var(--accent);
  }
  .stat-icon-purple {
    background: var(--cost-subtle);
    color: var(--cost);
  }
  .stat-icon-yellow {
    background: var(--yellow-subtle);
    color: var(--yellow);
  }
  .stat-icon-red {
    background: var(--red-subtle);
    color: var(--red);
  }
  .stat-content {
    flex: 1;
    min-width: 0;
  }
  .stat-label {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 4px;
    font-weight: 500;
  }
  .stat-value {
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
  }
</style>
