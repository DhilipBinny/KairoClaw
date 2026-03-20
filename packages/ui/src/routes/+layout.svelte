<script lang="ts">
  import '../app.css';
  import { checkAuth, getIsAuthenticated, getIsLoading } from '$lib/stores/auth.svelte';
  import { getHealth } from '$lib/api';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import Toast from '$lib/components/Toast.svelte';
  import { initTheme } from '$lib/stores/theme.svelte';

  initTheme();

  let { children } = $props();

  let isAuthenticated = $derived(getIsAuthenticated());
  let isLoading = $derived(getIsLoading());

  $effect(() => {
    checkAuth().then(async (ok) => {
      const currentPath = String(page.url?.pathname || '/');
      // Allow /setup and /login without auth
      if (currentPath === '/setup' || currentPath === '/login') return;
      if (!ok) {
        // Check if this is a first-run — redirect to setup wizard instead of login
        try {
          const health = await getHealth();
          if (health.firstRun) {
            goto('/setup');
            return;
          }
        } catch { /* fall through to login */ }
        goto('/login');
      }
    });
  });
</script>

<a href="#main-content" class="skip-link">Skip to main content</a>

{#if isLoading}
  <div class="loading-screen">
    <div class="loading-logo">A</div>
    <div class="loading-text">Loading...</div>
  </div>
{:else if isAuthenticated || String(page.url?.pathname) === '/login' || String(page.url?.pathname) === '/setup'}
  {@render children()}
  <Toast />
{:else}
  <div class="loading-screen">
    <div class="loading-text">Redirecting...</div>
  </div>
{/if}

<style>
  .skip-link {
    position: absolute;
    top: -100%;
    left: 16px;
    z-index: 9999;
    padding: 8px 16px;
    background: var(--accent);
    color: #fff;
    border-radius: 8px;
    font-size: 14px;
    text-decoration: none;
    transition: top 0.2s ease;
  }
  .skip-link:focus {
    top: 16px;
  }

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
