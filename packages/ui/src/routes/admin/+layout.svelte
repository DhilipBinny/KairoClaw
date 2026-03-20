<script lang="ts">
  import AdminNav from '$lib/components/AdminNav.svelte';

  let { children } = $props();
  let navOpen = $state(false);
</script>

<div class="admin-layout">
  <div class="admin-nav-wrapper" class:open={navOpen}>
    <AdminNav />
  </div>
  {#if navOpen}
    <button class="admin-nav-backdrop" onclick={() => navOpen = false} aria-label="Close navigation"></button>
  {/if}
  <main class="admin-content" id="main-content">
    <div class="mobile-header">
      <button class="mobile-nav-toggle" onclick={() => navOpen = !navOpen} aria-label="Toggle navigation">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="3" y1="12" x2="21" y2="12"></line>
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <line x1="3" y1="18" x2="21" y2="18"></line>
        </svg>
      </button>
      <span class="mobile-header-title">Admin</span>
    </div>
    {@render children()}
  </main>
</div>

<style>
  .admin-layout {
    display: flex;
    height: 100vh;
    width: 100%;
  }
  .admin-nav-wrapper {
    display: contents;
  }
  .admin-content {
    flex: 1;
    overflow-y: auto;
    padding: 24px 32px;
    min-width: 0;
  }
  .mobile-header {
    display: none;
  }
  .admin-nav-backdrop {
    display: none;
  }

  @media (max-width: 768px) {
    .admin-nav-wrapper {
      display: block;
      position: fixed;
      top: 0;
      left: 0;
      height: 100vh;
      z-index: 100;
      transform: translateX(-100%);
      transition: transform var(--duration-slow) var(--ease);
    }
    .admin-nav-wrapper.open {
      transform: translateX(0);
    }
    .admin-nav-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 99;
      background: rgba(0, 0, 0, 0.5);
      border: none;
      cursor: pointer;
    }
    .admin-content {
      padding: 0 16px 16px;
    }
    .mobile-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 0;
      margin-bottom: 8px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .mobile-nav-toggle {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: var(--bg-surface);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--duration) var(--ease);
    }
    .mobile-nav-toggle:hover {
      background: var(--bg-raised);
      color: var(--text-primary);
    }
    .mobile-header-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-secondary);
    }
  }
</style>
