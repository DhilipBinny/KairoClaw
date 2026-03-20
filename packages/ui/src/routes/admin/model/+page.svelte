<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  onMount(() => {
    goto('/admin/providers', { replaceState: true });
  });
</script>

<div style="padding: 40px; color: var(--text-muted);">Redirecting to Providers & Models...</div>
