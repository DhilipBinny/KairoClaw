<script lang="ts">
  interface Props {
    title: string;
    description?: string;
  }

  let { title, description }: Props = $props();
</script>

<div class="empty-state">
  <svg class="empty-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <line x1="9" y1="9" x2="15" y2="15"></line>
    <line x1="15" y1="9" x2="9" y2="15"></line>
  </svg>
  <span class="empty-title">{title}</span>
  {#if description}
    <span class="empty-description">{description}</span>
  {/if}
</div>

<style>
  .empty-state {
    padding: 40px 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .empty-icon {
    color: var(--text-ghost);
    margin-bottom: 4px;
  }
  .empty-title {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-secondary);
  }
  .empty-description {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 320px;
  }
</style>
