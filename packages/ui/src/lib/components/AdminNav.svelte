<script lang="ts">
  import { page } from '$app/state';

  interface NavItem {
    href: string;
    label: string;
    icon: string; // SVG path(s)
  }

  // Lucide-style SVG paths (24x24 viewBox)
  const configItems: NavItem[] = [
    { href: '/admin', label: 'Dashboard',
      icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
    { href: '/admin/personas', label: 'Personas',
      icon: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
    { href: '/admin/providers', label: 'Providers & Models',
      icon: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>' },
    { href: '/admin/channels', label: 'Channels',
      icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
    { href: '/admin/settings', label: 'Settings',
      icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
    { href: '/admin/mcp', label: 'MCP Servers',
      icon: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>' },
    { href: '/admin/plugins', label: 'Plugins',
      icon: '<path d="M12 2v6m0 12v2M4.93 4.93l4.24 4.24m5.66 5.66l4.24 4.24M2 12h6m8 0h6M4.93 19.07l4.24-4.24m5.66-5.66l4.24-4.24"/>' },
  ];

  const opsItems: NavItem[] = [
    { href: '/admin/cron', label: 'Cron Jobs',
      icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
    { href: '/admin/sessions', label: 'Sessions',
      icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" y1="10" x2="15" y2="10"/>' },
    { href: '/admin/logs', label: 'Logs',
      icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' },
    { href: '/admin/usage', label: 'Usage (Beta)',
      icon: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>' },
  ];

  function isActive(href: string): boolean {
    const path = page.url?.pathname || '';
    if (href === '/admin') return path === '/admin';
    return path.startsWith(href);
  }
</script>

<nav class="admin-nav">
  <div class="nav-header">
    <a href="/" class="nav-brand">
      <img src="/logo.png" alt="Kairo" class="nav-logo-img" />
      <div class="nav-brand-text">
        <span class="nav-title">Kairo</span>
        <span class="nav-subtitle">Admin</span>
      </div>
    </a>
  </div>

  <div class="nav-items">
    <div class="nav-group-label">Configuration</div>
    {#each configItems as item}
      <a href={item.href} class="nav-item" class:active={isActive(item.href)}>
        <svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          {@html item.icon}
        </svg>
        <span class="nav-label">{item.label}</span>
        {#if isActive(item.href)}
          <span class="nav-active-dot"></span>
        {/if}
      </a>
    {/each}

    <div class="nav-divider"></div>

    <div class="nav-group-label">Operations</div>
    {#each opsItems as item}
      <a href={item.href} class="nav-item" class:active={isActive(item.href)}>
        <svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          {@html item.icon}
        </svg>
        <span class="nav-label">{item.label}</span>
        {#if isActive(item.href)}
          <span class="nav-active-dot"></span>
        {/if}
      </a>
    {/each}
  </div>

  <div class="nav-footer">
    <a href="/" class="nav-item nav-back">
      <svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="19" y1="12" x2="5" y2="12"></line>
        <polyline points="12 19 5 12 12 5"></polyline>
      </svg>
      <span class="nav-label">Back to Chat</span>
    </a>
  </div>
</nav>

<style>
  .admin-nav {
    width: var(--sidebar-width);
    background: var(--bg-surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    height: 100vh;
    height: 100dvh;
  }
  .nav-header {
    padding: 20px 16px 16px;
    border-bottom: 1px solid var(--border);
  }
  .nav-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    text-decoration: none;
    color: var(--text-primary);
  }
  .nav-logo-img {
    width: 34px;
    height: 34px;
    border-radius: 8px;
    flex-shrink: 0;
    object-fit: cover;
  }
  .nav-brand-text {
    display: flex;
    flex-direction: column;
  }
  .nav-title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.3px;
    line-height: 1.2;
  }
  .nav-subtitle {
    font-size: 11px;
    color: var(--text-muted);
    letter-spacing: 0.2px;
  }
  .nav-items {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }
  .nav-group-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-ghost);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    padding: 12px 12px 6px;
  }
  .nav-divider {
    height: 1px;
    background: var(--border);
    margin: 8px 12px;
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border-radius: var(--radius);
    color: var(--text-secondary);
    text-decoration: none;
    font-size: 13px;
    font-weight: 500;
    transition: all var(--duration) var(--ease);
    margin-bottom: 4px;
    position: relative;
  }
  .nav-item:hover {
    background: var(--bg-raised);
    color: var(--text-primary);
  }
  .nav-item.active {
    background: var(--accent-subtle);
    color: var(--accent);
    border-left: 3px solid var(--accent);
    padding-left: 9px;
  }
  .nav-active-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    margin-left: auto;
    flex-shrink: 0;
    box-shadow: 0 0 6px rgba(99, 102, 241, 0.4);
  }
  .nav-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
  .nav-footer {
    padding: 8px;
    border-top: 1px solid var(--border);
  }
  .nav-back {
    gap: 8px;
  }
</style>
