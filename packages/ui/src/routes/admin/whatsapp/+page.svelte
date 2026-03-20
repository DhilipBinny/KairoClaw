<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  onMount(() => {
    goto('/admin/channels', { replaceState: true });
  });
</script>

<svelte:head>
  <title>Redirecting... - Admin - Kairo</title>
</svelte:head>

<div class="redirect">
  <span class="spinner"></span> Redirecting to Channels...
</div>

<style>
  .redirect {
    color: var(--text-muted);
    padding: 40px 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
</style>
