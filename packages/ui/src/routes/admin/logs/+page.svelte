<script lang="ts">
  import LogViewer from '$lib/components/LogViewer.svelte';
</script>

<svelte:head>
  <title>Logs - Admin - Kairo</title>
</svelte:head>

<div class="logs-page">
  <h1 class="page-title">Logs</h1>
  <p class="page-desc">Real-time server logs with level filtering.</p>

  <div class="logs-container">
    <LogViewer />
  </div>
</div>

<style>
  .logs-page {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 48px);
    height: calc(100dvh - 48px);
  }
  .page-title {
    font-size: 24px;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .page-desc {
    color: var(--text-muted);
    font-size: 14px;
    margin-bottom: 16px;
  }
  .logs-container {
    flex: 1;
    min-height: 0;
  }

  @media (max-width: 768px) {
    .page-title { font-size: 24px; }
    .page-desc { font-size: 13px; }
  }
</style>
