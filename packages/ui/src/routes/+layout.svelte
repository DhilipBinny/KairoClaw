<script lang="ts">
  import '../app.css';
  import { checkAuth, getIsAuthenticated, getIsLoading } from '$lib/stores/auth.svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';

  let { children } = $props();

  let isAuthenticated = $derived(getIsAuthenticated());
  let isLoading = $derived(getIsLoading());

  $effect(() => {
    checkAuth().then((ok) => {
      const path = page.url?.pathname || '/';
      if (!ok && path !== '/login') {
        goto('/login');
      }
    });
  });
</script>

{#if isLoading}
  <div class="loading-screen">
    <div class="loading-logo">A</div>
    <div class="loading-text">Loading...</div>
  </div>
{:else if isAuthenticated || page.url?.pathname === '/login'}
  {@render children()}
{:else}
  <div class="loading-screen">
    <div class="loading-text">Redirecting...</div>
  </div>
{/if}

<style>
  .loading-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    gap: 16px;
  }
  .loading-logo {
    width: 48px;
    height: 48px;
    background: linear-gradient(135deg, var(--accent), #a78bfa);
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    font-weight: 700;
    color: #fff;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.7; transform: scale(0.95); }
  }
  .loading-text {
    color: var(--text-muted);
    font-size: 14px;
  }
</style>
