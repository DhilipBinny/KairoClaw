<script lang="ts">
  import '../app.css';
  import { checkAuth, getIsAuthenticated, getIsLoading } from '$lib/stores/auth.svelte';
  import { getHealth } from '$lib/api';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import Toast from '$lib/components/Toast.svelte';
  import { initTheme } from '$lib/stores/theme.svelte';
  import { initPwa, onUpdateAvailable, applyUpdate } from '$lib/pwa';

  initTheme();
  initPwa();

  let showUpdateToast = $state(false);
  onUpdateAvailable(() => { showUpdateToast = true; });

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

  {#if showUpdateToast}
    <div class="pwa-toast">
      <span>New version available</span>
      <button onclick={() => { applyUpdate(); }}>Update</button>
      <button class="dismiss" onclick={() => { showUpdateToast = false; }}>Later</button>
    </div>
  {/if}
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

  .pwa-toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-secondary, #1a1a2e);
    border: 1px solid var(--border, #333);
    border-radius: 10px;
    padding: 10px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 13px;
    color: var(--text);
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    z-index: 10000;
  }
  .pwa-toast button {
    padding: 5px 12px;
    border-radius: 6px;
    border: none;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    background: var(--accent, #6366f1);
    color: white;
  }
  .pwa-toast button.dismiss {
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border, #333);
  }
</style>
