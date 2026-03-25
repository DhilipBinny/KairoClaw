<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getUsers, createUser, updateUser, deactivateUser, reactivateUser,
    permanentDeleteUser, regenerateApiKey, linkSender, unlinkSender,
    getPendingSenders,
    type UserInfo,
  } from '$lib/api';

  let users: UserInfo[] = $state([]);
  let loading = $state(true);
  let error = $state('');

  // Create user modal
  let showCreate = $state(false);
  let createName = $state('');
  let createEmail = $state('');
  let createRole = $state('user');
  let createElevated = $state(false);
  let createdApiKey = $state('');

  // Edit modal
  let editUser: UserInfo | null = $state(null);
  let editName = $state('');
  let editEmail = $state('');
  let editRole = $state('user');
  let editElevated = $state(false);

  // Link sender
  let linkUserId = $state('');
  let linkChannel = $state('telegram');
  let linkSenderId = $state('');

  // Pending senders for quick-link
  let pendingSenders: Array<{ id: number; channel: string; sender_id: string; sender_name: string; status: string }> = $state([]);

  // Regenerated key display
  let newApiKey = $state('');
  let newApiKeyUserId = $state('');

  // Regenerate key modal
  let regenUserId = $state('');
  let regenUserName = $state('');
  let regenConfirmText = $state('');

  async function loadUsers() {
    loading = true;
    error = '';
    try {
      users = await getUsers();
    } catch (e: any) {
      error = e.message || 'Failed to load users';
    } finally {
      loading = false;
    }
  }

  async function loadPendingSenders() {
    try {
      const data = await getPendingSenders();
      pendingSenders = (data.senders || []).filter((s: any) => s.status === 'pending' || s.status === 'approved');
    } catch { /* ignore */ }
  }

  async function handleCreate() {
    error = '';
    createdApiKey = '';
    try {
      const result = await createUser({
        name: createName.trim(),
        email: createEmail.trim() || undefined,
        role: createRole,
        elevated: createElevated,
      });
      createdApiKey = result.api_key;
      await loadUsers();
    } catch (e: any) {
      error = e.message || 'Failed to create user';
    }
  }

  function startEdit(u: UserInfo) {
    editUser = u;
    editName = u.name;
    editEmail = u.email || '';
    editRole = u.role;
    editElevated = u.elevated;
  }

  async function handleEdit() {
    if (!editUser) return;
    error = '';
    try {
      await updateUser(editUser.id, {
        name: editName.trim(),
        email: editEmail.trim() || undefined,
        role: editRole,
        elevated: editElevated,
      });
      editUser = null;
      await loadUsers();
    } catch (e: any) {
      error = e.message || 'Failed to update user';
    }
  }

  async function handleDeactivate(id: string) {
    if (!confirm('Deactivate this user? They will no longer be able to access the system.')) return;
    try {
      await deactivateUser(id);
      await loadUsers();
    } catch (e: any) {
      error = e.message;
    }
  }

  async function handleReactivate(id: string) {
    try {
      await reactivateUser(id);
      await loadUsers();
    } catch (e: any) {
      error = e.message;
    }
  }

  async function handlePermanentDelete(id: string) {
    if (!confirm('PERMANENTLY delete this user and all their data? This cannot be undone.')) return;
    try {
      await permanentDeleteUser(id);
      await loadUsers();
    } catch (e: any) {
      error = e.message;
    }
  }

  function startRegenKey(u: UserInfo) {
    regenUserId = u.id;
    regenUserName = u.name;
    regenConfirmText = '';
  }

  async function handleRegenerateKey() {
    if (regenConfirmText !== 'REGENERATE') return;
    try {
      const result = await regenerateApiKey(regenUserId);
      newApiKey = result.api_key;
      newApiKeyUserId = regenUserId;
      regenUserId = '';
      regenConfirmText = '';
    } catch (e: any) {
      error = e.message;
    }
  }

  async function handleLinkSender() {
    if (!linkUserId || !linkSenderId.trim()) return;
    error = '';
    try {
      await linkSender(linkUserId, linkChannel, linkSenderId.trim());
      linkSenderId = '';
      linkUserId = '';
      await loadUsers();
    } catch (e: any) {
      error = e.message;
    }
  }

  async function handleUnlink(userId: string, linkId: number) {
    try {
      await unlinkSender(userId, linkId);
      await loadUsers();
    } catch (e: any) {
      error = e.message;
    }
  }

  function copyKey(key: string) {
    navigator.clipboard.writeText(key);
  }

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  }

  onMount(() => {
    loadUsers();
    loadPendingSenders();
  });
</script>

<svelte:head>
  <title>Users - Admin - Kairo</title>
</svelte:head>

<div class="users-page">
  <div class="page-header">
    <div>
      <h1 class="page-title">Users</h1>
      <p class="page-desc">Manage user accounts, roles, and channel sender links.</p>
    </div>
    <button class="btn btn-primary" onclick={() => { showCreate = true; createdApiKey = ''; createName = ''; createEmail = ''; createRole = 'user'; createElevated = false; }}>
      + Add User
    </button>
  </div>

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  {#if loading}
    <div class="loading"><span class="spinner"></span> Loading users...</div>
  {:else if users.length === 0}
    <div class="empty-state">No users yet. Create one to get started.</div>
  {:else}
    <div class="card table-card">
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              <th>Linked Senders</th>
              <th>Sessions</th>
              <th>Usage (30d)</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each users as u}
              <tr class:inactive={!u.active}>
                <td>
                  <div class="user-name">{u.name}</div>
                  {#if u.email}<div class="user-email">{u.email}</div>{/if}
                </td>
                <td>
                  <span class="badge badge-{u.role}">{u.role}</span>
                  {#if u.elevated}<span class="badge badge-elevated" title="Has access to dangerous tools">elevated</span>{/if}
                </td>
                <td>
                  {#if u.active}
                    <span class="status-dot active"></span> Active
                  {:else}
                    <span class="status-dot inactive"></span> Deactivated
                  {/if}
                </td>
                <td>
                  {#if u.sender_links.length > 0}
                    {#each u.sender_links as link}
                      <span class="sender-tag">
                        {link.channel_type}:{link.sender_id.slice(0, 12)}{link.sender_id.length > 12 ? '...' : ''}
                        <button class="tag-remove" title="Unlink" onclick={() => handleUnlink(u.id, link.id)}>&times;</button>
                      </span>
                    {/each}
                  {:else}
                    <span class="text-muted">None</span>
                  {/if}
                </td>
                <td>{u.session_count}</td>
                <td>
                  <span title="{u.usage.total_input + u.usage.total_output} tokens, ${u.usage.total_cost.toFixed(4)}">
                    {formatTokens(u.usage.total_input + u.usage.total_output)} tok
                  </span>
                </td>
                <td class="actions-cell">
                  <button class="btn-sm" onclick={() => startEdit(u)}>Edit</button>
                  <button class="btn-sm" onclick={() => startRegenKey(u)}>Key</button>
                  <button class="btn-sm" onclick={() => { linkUserId = u.id; }}>Link</button>
                  {#if u.active}
                    <button class="btn-sm btn-danger" onclick={() => handleDeactivate(u.id)}>Deactivate</button>
                  {:else}
                    <button class="btn-sm btn-success" onclick={() => handleReactivate(u.id)}>Reactivate</button>
                    <button class="btn-sm btn-danger" onclick={() => handlePermanentDelete(u.id)}>Delete</button>
                  {/if}
                </td>
              </tr>

              {#if newApiKey && newApiKeyUserId === u.id}
                <tr>
                  <td colspan="7">
                    <div class="key-display">
                      New API key (copy now, shown only once):
                      <code class="key-value">{newApiKey}</code>
                      <button class="btn-sm" onclick={() => { copyKey(newApiKey); }}>Copy</button>
                      <button class="btn-sm" onclick={() => { newApiKey = ''; newApiKeyUserId = ''; }}>Dismiss</button>
                    </div>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}

  <!-- Create User Modal -->
  {#if showCreate}
    <div class="modal-overlay" onclick={() => { if (!createdApiKey) showCreate = false; }} role="presentation">
      <div class="modal card" onclick={(e) => e.stopPropagation()} role="dialog">
        <h2 class="modal-title">{createdApiKey ? 'User Created' : 'Add User'}</h2>

        {#if createdApiKey}
          <div class="key-display">
            <p>Save this API key now. It will not be shown again.</p>
            <code class="key-value">{createdApiKey}</code>
            <button class="btn btn-primary" onclick={() => { copyKey(createdApiKey); }}>Copy to Clipboard</button>
            <button class="btn" onclick={() => { showCreate = false; createdApiKey = ''; }}>Done</button>
          </div>
        {:else}
          <div class="form-group">
            <label class="label">Name *</label>
            <input class="input" type="text" bind:value={createName} placeholder="User name" />
          </div>
          <div class="form-group">
            <label class="label">Email</label>
            <input class="input" type="email" bind:value={createEmail} placeholder="Optional" />
          </div>
          <div class="form-group">
            <label class="label">Role</label>
            <select class="input" bind:value={createRole}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" bind:checked={createElevated} />
              Elevated (access to exec, cron, file write/delete)
            </label>
          </div>
          <div class="modal-actions">
            <button class="btn" onclick={() => showCreate = false}>Cancel</button>
            <button class="btn btn-primary" onclick={handleCreate} disabled={!createName.trim()}>Create User</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Edit User Modal -->
  {#if editUser}
    <div class="modal-overlay" onclick={() => editUser = null} role="presentation">
      <div class="modal card" onclick={(e) => e.stopPropagation()} role="dialog">
        <h2 class="modal-title">Edit User</h2>
        <div class="form-group">
          <label class="label">Name</label>
          <input class="input" type="text" bind:value={editName} />
        </div>
        <div class="form-group">
          <label class="label">Email</label>
          <input class="input" type="email" bind:value={editEmail} />
        </div>
        <div class="form-group">
          <label class="label">Role</label>
          <select class="input" bind:value={editRole}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={editElevated} />
            Elevated (access to exec, cron, file write/delete)
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn" onclick={() => editUser = null}>Cancel</button>
          <button class="btn btn-primary" onclick={handleEdit}>Save</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Link Sender Modal -->
  {#if linkUserId}
    <div class="modal-overlay" onclick={() => linkUserId = ''} role="presentation">
      <div class="modal card" onclick={(e) => e.stopPropagation()} role="dialog">
        <h2 class="modal-title">Link Channel Sender</h2>
        <p class="text-muted" style="margin-bottom: 16px;">Link a Telegram user ID or WhatsApp phone number to this user account.</p>

        {#if pendingSenders.length > 0}
          <div class="form-group">
            <label class="label">Quick link from pending senders</label>
            <div class="pending-list">
              {#each pendingSenders as ps}
                <button class="pending-item" onclick={() => { linkChannel = ps.channel; linkSenderId = ps.sender_id; }}>
                  <span class="badge badge-{ps.channel}">{ps.channel}</span>
                  {ps.sender_name || ps.sender_id}
                  <span class="text-muted">({ps.sender_id})</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <div class="form-group">
          <label class="label">Channel</label>
          <select class="input" bind:value={linkChannel}>
            <option value="telegram">Telegram</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
        </div>
        <div class="form-group">
          <label class="label">Sender ID</label>
          <input class="input" type="text" bind:value={linkSenderId} placeholder={linkChannel === 'telegram' ? 'Telegram user ID (numeric)' : 'Phone number'} />
        </div>
        <div class="modal-actions">
          <button class="btn" onclick={() => linkUserId = ''}>Cancel</button>
          <button class="btn btn-primary" onclick={handleLinkSender} disabled={!linkSenderId.trim()}>Link</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Regenerate Key Modal -->
  {#if regenUserId}
    <div class="modal-overlay" onclick={() => regenUserId = ''} role="presentation">
      <div class="modal card" onclick={(e) => e.stopPropagation()} role="dialog">
        <h2 class="modal-title">Regenerate API Key</h2>
        <div class="warning-box">
          The current API key for <strong>{regenUserName}</strong> will be <strong>permanently invalidated</strong>. The user will be locked out until they receive the new key.
        </div>
        <div class="form-group">
          <label class="label">Type REGENERATE to confirm</label>
          <input class="input" type="text" bind:value={regenConfirmText} placeholder="REGENERATE" autocomplete="off" />
        </div>
        <div class="modal-actions">
          <button class="btn" onclick={() => regenUserId = ''}>Cancel</button>
          <button class="btn btn-danger" onclick={handleRegenerateKey} disabled={regenConfirmText !== 'REGENERATE'}>Regenerate Key</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .users-page { max-width: 1100px; }
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 24px;
  }
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.3px; }
  .page-desc { color: var(--text-muted); font-size: 14px; }
  .loading, .empty-state {
    color: var(--text-muted); padding: 40px 0; text-align: center;
    display: flex; align-items: center; justify-content: center; gap: 10px;
  }
  .error-banner {
    background: var(--red-subtle, #fef2f2); color: var(--red, #ef4444);
    padding: 10px 16px; border-radius: var(--radius); margin-bottom: 16px;
    font-size: 13px;
  }

  .table-card { padding: 0; overflow: hidden; }
  .table-wrapper { overflow-x: auto; }
  .data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .data-table th, .data-table td { padding: 12px 14px; text-align: left; border-bottom: 1px solid var(--border); }
  .data-table th {
    font-size: 11px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.5px; background: var(--bg-raised);
  }
  .data-table tbody tr { transition: background var(--duration) var(--ease); }
  .data-table tbody tr:hover { background: var(--bg-raised); }
  .data-table tbody tr.inactive { opacity: 0.6; }

  .user-name { font-weight: 600; }
  .user-email { font-size: 12px; color: var(--text-muted); }

  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 11px; font-weight: 600; text-transform: uppercase;
  }
  .badge-admin { background: var(--accent-subtle); color: var(--accent); }
  .badge-user { background: var(--bg-raised); color: var(--text-secondary); }
  .badge-elevated { background: #fef3c7; color: #d97706; margin-left: 4px; }
  .badge-telegram { background: #e0f2fe; color: #0284c7; }
  .badge-whatsapp { background: #dcfce7; color: #16a34a; }

  .status-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px;
  }
  .status-dot.active { background: var(--green, #22c55e); }
  .status-dot.inactive { background: var(--text-muted); }

  .sender-tag {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--bg-raised); padding: 2px 8px; border-radius: 4px;
    font-size: 11px; font-family: var(--font-mono); margin: 2px;
  }
  .tag-remove {
    background: none; border: none; cursor: pointer; color: var(--text-muted);
    font-size: 14px; padding: 0 2px; line-height: 1;
  }
  .tag-remove:hover { color: var(--red, #ef4444); }

  .actions-cell { white-space: nowrap; }

  .btn { padding: 8px 16px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-primary); cursor: pointer; font-size: 13px; font-weight: 500; }
  .btn:hover { background: var(--bg-raised); }
  .btn-primary { background: var(--accent); color: white; border-color: var(--accent); }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-sm { padding: 4px 10px; font-size: 12px; border: 1px solid var(--border); background: var(--bg-surface); border-radius: var(--radius); cursor: pointer; color: var(--text-secondary); }
  .btn-sm:hover { background: var(--bg-raised); color: var(--text-primary); }
  .btn-danger { color: var(--red, #ef4444); border-color: var(--red, #ef4444); }
  .btn-danger:hover { background: var(--red-subtle, #fef2f2); }
  .warning-box {
    background: var(--red-subtle, #fef2f2); color: var(--red, #ef4444);
    padding: 12px 16px; border-radius: var(--radius); margin-bottom: 16px;
    font-size: 13px; line-height: 1.5; border: 1px solid var(--red, #ef4444);
  }
  .btn-success { color: var(--green, #22c55e); border-color: var(--green, #22c55e); }
  .btn-success:hover { background: var(--green-subtle, #f0fdf4); }

  .key-display {
    background: var(--bg-raised); padding: 12px 16px; border-radius: var(--radius);
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    font-size: 13px;
  }
  .key-value {
    font-family: var(--font-mono); font-size: 12px;
    background: var(--bg-surface); padding: 4px 8px; border-radius: 4px;
    word-break: break-all; flex: 1; min-width: 200px;
  }

  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center; z-index: 100;
  }
  .modal { padding: 24px; min-width: 400px; max-width: 500px; }
  .modal-title { font-size: 18px; font-weight: 700; margin-bottom: 16px; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }

  .form-group { margin-bottom: 14px; }
  .label { display: block; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.3px; }
  .input { width: 100%; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-surface); color: var(--text-primary); font-size: 14px; }
  .checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }

  .text-muted { color: var(--text-muted); }

  .pending-list { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .pending-item {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--bg-surface); cursor: pointer; font-size: 12px; text-align: left;
  }
  .pending-item:hover { background: var(--bg-raised); }

  @media (max-width: 768px) {
    .page-title { font-size: 20px; }
    .page-header { flex-direction: column; gap: 12px; }
    .modal { min-width: unset; width: 90vw; }
  }
</style>
