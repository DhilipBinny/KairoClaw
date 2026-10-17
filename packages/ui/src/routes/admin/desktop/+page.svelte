<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getConfig, updateConfig } from '$lib/api';
  import { logout } from '$lib/stores/auth.svelte';
  import { goto } from '$app/navigation';

  let loading = $state(true);
  let config: Record<string, unknown> | null = $state(null);
  let containers: Array<{
    userId: string;
    containerId: string;
    containerIp: string;
    hostPorts?: Record<string, number>;
    desktopSecrets?: { vncPassword: string; sessionToken: string };
    createdAt: number;
    uptimeMs: number;
  }> = $state([]);
  let users: Array<{ id: string; name: string }> = $state([]);
  let desktopUsers: string[] = $state([]);
  let actionInProgress = $state('');
  let feedback = $state('');
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function loadData() {
    try {
      const [configRes, listRes] = await Promise.all([
        fetch('/api/v1/admin/config', { headers: { 'Authorization': `Bearer ${localStorage.getItem('agw_api_key')}` } }),
        fetch('/api/v1/admin/desktop/list', { headers: { 'Authorization': `Bearer ${localStorage.getItem('agw_api_key')}` } }),
      ]);
      if (configRes.status === 401 || listRes.status === 401) { logout(); goto('/login'); return; }
      const configData = await configRes.json();
      const listData = await listRes.json();
      config = configData.config;
      containers = listData.containers || [];
      desktopUsers = ((config as any)?.tools?.sandbox?.desktopUsers || []) as string[];

      // Load users list
      const usersRes = await fetch('/api/v1/admin/users', { headers: { 'Authorization': `Bearer ${localStorage.getItem('agw_api_key')}` } });
      if (usersRes.ok) {
        const usersData = await usersRes.json();
        users = Array.isArray(usersData) ? usersData : (usersData.users || []);
      }
    } catch { /* ignore */ }
    finally { loading = false; }
  }

  async function startDesktop(userId: string) {
    actionInProgress = userId;
    feedback = '';
    try {
      const res = await fetch(`/api/v1/admin/desktop/${userId}/start`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('agw_api_key')}` },
      });
      const data = await res.json();
      if (!res.ok) { feedback = data.error || 'Failed'; return; }
      feedback = 'Started';
      await loadData();
    } catch (e: any) { feedback = e.message; }
    finally { actionInProgress = ''; setTimeout(() => feedback = '', 3000); }
  }

  async function stopDesktop(userId: string) {
    if (!confirm(`Stop desktop for ${userId}?`)) return;
    actionInProgress = userId;
    try {
      await fetch(`/api/v1/admin/desktop/${userId}/stop`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('agw_api_key')}` },
      });
      await loadData();
    } catch { /* ignore */ }
    finally { actionInProgress = ''; }
  }

  async function toggleDesktopUser(userId: string) {
    const current = [...desktopUsers];
    const idx = current.indexOf(userId);
    if (idx >= 0) current.splice(idx, 1);
    else current.push(userId);

    try {
      const res = await fetch('/api/v1/admin/config', {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('agw_api_key')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: 'tools.sandbox.desktopUsers', value: current }),
      });
      if (res.ok) {
        desktopUsers = current;
      }
    } catch { /* ignore */ }
  }

  function getWorkspaceUrl(userId: string): string | null {
    const container = getContainerForUser(userId);
    if (!container) return null;
    return `/api/v1/admin/desktop/${userId}/workspace`;
  }

  function getContainerForUser(userId: string) {
    return containers.find(c => c.userId === userId);
  }

  function formatUptime(ms: number): string {
    const min = Math.floor(ms / 60000);
    if (min < 60) return `${min}m`;
    const hrs = Math.floor(min / 60);
    return `${hrs}h ${min % 60}m`;
  }

  onMount(() => {
    loadData();
    pollTimer = setInterval(loadData, 10000);
  });
  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<svelte:head><title>Desktop - Admin - Kairo</title></svelte:head>

<div class="page">
  <div class="header">
    <div class="header-left">
      <h1>Cloud Desktop</h1>
      <p class="subtitle">Manage desktop workspace containers for users</p>
    </div>
  </div>

  {#if loading}
    <div class="loading">Loading...</div>
  {:else}

    <!-- Users Table -->
    <div class="section">
      <h2>Users</h2>
      <div class="card">
        <table class="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Desktop Enabled</th>
              <th>Status</th>
              <th>Uptime</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each users as user}
              {@const container = getContainerForUser(user.id)}
              {@const enabled = desktopUsers.includes(user.id)}
              <tr>
                <td class="user-name">{user.name || user.id}</td>
                <td>
                  <button
                    class="toggle-btn"
                    class:active={enabled}
                    onclick={() => toggleDesktopUser(user.id)}
                  >
                    <span class="toggle-track"><span class="toggle-thumb"></span></span>
                    <span class="toggle-label">{enabled ? 'On' : 'Off'}</span>
                  </button>
                </td>
                <td>
                  {#if container}
                    <span class="badge badge-green">Running</span>
                  {:else}
                    <span class="badge badge-dim">Stopped</span>
                  {/if}
                </td>
                <td>{container ? formatUptime(container.uptimeMs) : '—'}</td>
                <td class="actions">
                  {#if container}
                    <a class="btn btn-sm btn-primary" href={getWorkspaceUrl(user.id)} target="_blank" rel="noopener">Open</a>
                    <button class="btn btn-sm btn-danger" onclick={() => stopDesktop(user.id)} disabled={actionInProgress === user.id}>Stop</button>
                  {:else if enabled}
                    <button class="btn btn-sm btn-primary" onclick={() => startDesktop(user.id)} disabled={actionInProgress === user.id}>
                      {actionInProgress === user.id ? 'Starting...' : 'Start'}
                    </button>
                  {:else}
                    <span class="text-dim">Enable first</span>
                  {/if}
                </td>
              </tr>
            {/each}
            {#if users.length === 0}
              <tr><td colspan="5" class="text-dim" style="text-align:center; padding:20px">No users found</td></tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>

    {#if feedback}
      <div class="feedback">{feedback}</div>
    {/if}
  {/if}
</div>

<style>
  .page { max-width: 900px; margin: 0 auto; padding: 24px; }
  .header { margin-bottom: 24px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0; }
  .subtitle { color: var(--text-dim, #888); font-size: 13px; margin: 4px 0 0; }
  h2 { font-size: 16px; font-weight: 600; margin: 0 0 12px; }
  .section { margin-bottom: 24px; }
  .loading { text-align: center; padding: 40px; color: var(--text-dim, #888); }

  .card { background: var(--card-bg, #1a1a2e); border: 1px solid var(--border, #2a2a3e); border-radius: 8px; overflow: hidden; }
  .table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .table th { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border, #2a2a3e); color: var(--text-dim, #888); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .table td { padding: 10px 12px; border-bottom: 1px solid var(--border, #2a2a3e); }
  .table tbody tr:last-child td { border-bottom: none; }

  .user-name { font-weight: 500; }
  .actions { display: flex; gap: 6px; }
  .text-dim { color: var(--text-dim, #888); font-size: 12px; }

  .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
  .badge-green { background: rgba(74,222,128,0.15); color: #4ade80; }
  .badge-dim { background: rgba(136,136,160,0.1); color: var(--text-dim, #888); }

  .btn { border: none; border-radius: 6px; cursor: pointer; font-size: 12px; padding: 6px 12px; transition: all 0.15s; }
  .btn-sm { padding: 4px 10px; font-size: 11px; }
  .btn-primary { background: var(--accent, #6c63ff); color: #fff; }
  .btn-primary:hover { opacity: 0.9; }
  .btn-danger { background: var(--red, #f87171); color: #fff; }
  .btn-danger:hover { opacity: 0.9; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .toggle-btn { background: none; border: none; cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 0; }
  .toggle-track { width: 32px; height: 18px; border-radius: 9px; background: var(--border, #2a2a3e); position: relative; transition: background 0.2s; }
  .toggle-btn.active .toggle-track { background: var(--accent, #6c63ff); }
  .toggle-thumb { width: 14px; height: 14px; border-radius: 50%; background: #fff; position: absolute; top: 2px; left: 2px; transition: left 0.2s; }
  .toggle-btn.active .toggle-thumb { left: 16px; }
  .toggle-label { font-size: 12px; color: var(--text-dim, #888); }

  .feedback { position: fixed; bottom: 20px; right: 20px; background: var(--accent, #6c63ff); color: #fff; padding: 8px 16px; border-radius: 6px; font-size: 13px; }
</style>
