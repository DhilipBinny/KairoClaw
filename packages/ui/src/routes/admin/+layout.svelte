<script lang="ts">
  import AdminNav from '$lib/components/AdminNav.svelte';

  let { children } = $props();
</script>

<div class="admin-layout">
  <AdminNav />
  <main class="admin-content" id="main-content">
    {@render children()}
  </main>
</div>

<style>
  .admin-layout {
    display: flex;
    height: 100vh;
    width: 100%;
  }
  .admin-content {
    flex: 1;
    overflow-y: auto;
    padding: 24px 32px;
    min-width: 0;
  }
</style>
