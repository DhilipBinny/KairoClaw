<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { checkAuth, getUser, getIsAuthenticated } from '$lib/stores/auth.svelte';

  let { children } = $props();
  let authorized = $state(false);
  let userRole = $state('');

  onMount(async () => {
    if (getIsAuthenticated()) {
      const user = getUser();
      if (user) {
        authorized = true;
        userRole = user.role;
        // Admin should use /admin/ instead
        if (user.role === 'admin') { goto('/admin'); return; }
      } else {
        goto('/login');
      }
      return;
    }
    await checkAuth();
    const user = getUser();
    if (!user) { goto('/login'); return; }
    if (user.role === 'admin') { goto('/admin'); return; }
    authorized = true;
    userRole = user.role;
  });

  function isActive(href: string): boolean {
    const path = $page.url.pathname;
    if (href === '/my') return path === '/my';
    return path.startsWith(href);
  }

  const navItems = [
    { href: '/my', label: 'Dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4' },
    { href: '/my/sessions', label: 'My Sessions', icon: 'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z' },
    { href: '/my/usage', label: 'My Usage', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
    { href: '/my/cron', label: 'My Cron Jobs', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
  ];
</script>

{#if authorized}
<div class="portal-layout">
  <nav class="portal-nav">
    <div class="portal-brand">
      <a href="/">
        <img src="/logo.png" alt="Kairo" class="portal-logo" />
      </a>
      <span class="portal-title">My Dashboard</span>
    </div>
    <div class="portal-nav-items">
      {#each navItems as item}
        <a href={item.href} class="portal-nav-item" class:active={isActive(item.href)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d={item.icon}></path>
          </svg>
          {item.label}
        </a>
      {/each}
    </div>
    <div class="portal-nav-footer">
      <a href="/" class="portal-nav-item">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 18l-6-6 6-6"></path>
        </svg>
        Back to Chat
      </a>
    </div>
  </nav>
  <main class="portal-content">
    {@render children()}
  </main>
</div>
{/if}

<style>
  .portal-layout {
    display: flex;
    height: 100vh;
    height: 100dvh;
    width: 100%;
  }
  .portal-nav {
    width: 220px;
    min-width: 220px;
    background: var(--bg-surface);
    border-right: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    padding: 16px 0;
  }
  .portal-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px 16px;
    border-bottom: 1px solid var(--border-subtle);
    margin-bottom: 12px;
  }
  .portal-logo {
    width: 28px;
    height: 28px;
    border-radius: 8px;
  }
  .portal-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .portal-nav-items {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 8px;
  }
  .portal-nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-radius: var(--radius);
    font-size: 13px;
    color: var(--text-secondary);
    text-decoration: none;
    transition: all var(--duration) var(--ease);
  }
  .portal-nav-item:hover {
    background: var(--bg-raised);
    color: var(--text-primary);
  }
  .portal-nav-item.active {
    background: var(--bg-raised);
    color: var(--accent);
  }
  .portal-nav-footer {
    padding: 12px 8px 0;
    border-top: 1px solid var(--border-subtle);
  }
  .portal-content {
    flex: 1;
    overflow-y: auto;
    padding: 24px 32px;
  }

  @media (max-width: 768px) {
    .portal-layout {
      flex-direction: column;
    }
    .portal-nav {
      width: 100%;
      min-width: unset;
      border-right: none;
      border-bottom: 1px solid var(--border-subtle);
      padding: 8px 0;
    }
    .portal-brand {
      padding: 0 12px 8px;
      margin-bottom: 4px;
    }
    .portal-nav-items {
      flex-direction: row;
      overflow-x: auto;
      padding: 0 8px;
      gap: 4px;
    }
    .portal-nav-item {
      white-space: nowrap;
      font-size: 12px;
      padding: 6px 10px;
    }
    .portal-nav-footer {
      display: none;
    }
    .portal-content {
      padding: 16px;
    }
  }
</style>
