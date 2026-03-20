<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    variant?: 'default' | 'green' | 'yellow' | 'red' | 'blue';
    size?: 'sm' | 'md';
    children?: Snippet;
  }

  let { variant = 'default', size = 'sm', children }: Props = $props();
</script>

<span
  class="badge badge-{variant} badge-{size}"
>
  {#if children}{@render children()}{/if}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border-radius: 9999px;
    font-weight: 500;
    white-space: nowrap;
    letter-spacing: 0.2px;
    transition: background var(--duration, 200ms) ease;
  }
  .badge-sm {
    padding: 2px 9px;
    font-size: 11px;
  }
  .badge-md {
    padding: 4px 12px;
    font-size: 12px;
  }
  .badge-default {
    background: var(--bg-raised, #1c1c2a);
    color: var(--text-secondary, #9395a5);
  }
  .badge-green {
    background: var(--green-subtle, rgba(52, 211, 153, 0.1));
    color: var(--green, #34d399);
  }
  .badge-yellow {
    background: var(--yellow-subtle, rgba(251, 191, 36, 0.1));
    color: var(--yellow, #fbbf24);
  }
  .badge-red {
    background: var(--red-subtle, rgba(244, 63, 94, 0.08));
    color: var(--red, #f43f5e);
  }
  .badge-blue {
    background: var(--blue-subtle, rgba(56, 189, 248, 0.1));
    color: var(--blue, #38bdf8);
  }
</style>
