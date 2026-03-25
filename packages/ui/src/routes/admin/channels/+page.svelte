<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getConfig, getChannelsStatus, getWhatsAppQR, unpairWhatsApp, updateConfig, saveChannelCredentials, testTelegramBot, getPendingSenders, approveSender, rejectSender, onboardSender, getUsers } from '$lib/api';
  import type { PendingSender, UserInfo } from '$lib/api';
  import Badge from '$lib/components/Badge.svelte';
  import ChipInput from '$lib/components/ChipInput.svelte';

  interface TelegramStatus {
    enabled: boolean;
    connected: boolean;
    botUsername: string | null;
    hasToken?: boolean;
    tokenHint?: string | null;
  }

  interface WhatsAppStatus {
    enabled: boolean;
    status: string;
    phone: string | null;
    name: string | null;
  }

  let config: Record<string, unknown> | null = $state(null);
  let telegram = $state<TelegramStatus>({ enabled: false, connected: false, botUsername: null });
  let whatsapp = $state<WhatsAppStatus>({ enabled: false, status: 'loading', phone: null, name: null });
  let qrDataUrl = $state<string | null>(null);
  let loading = $state(true);
  let unpairing = $state(false);
  let confirmUnpair = $state(false);
  let confirmUnpairTimer: ReturnType<typeof setTimeout> | null = null;
  let error = $state<string | null>(null);
  let pollInterval: ReturnType<typeof setInterval> | undefined;

  // Telegram bot token form
  let showBotToken = $state(false);
  let showTokenForm = $state(false);
  let botTokenInput = $state('');
  let savingToken = $state(false);
  let tokenMsg = $state('');

  // Telegram test connection
  let testingTelegram = $state(false);
  let telegramTestResult = $state<{ success: boolean; username?: string; error?: string } | null>(null);

  // Pending senders (P3)
  let pendingSenders = $state<PendingSender[]>([]);
  let senderCounts = $state<{ pending: number; seen: number }>({ pending: 0, seen: 0 });
  let approvingId = $state<number | null>(null);
  let rejectingId = $state<number | null>(null);

  // Onboard modal
  let onboardSenderData = $state<PendingSender | null>(null);
  let onboardName = $state('');
  let onboardEmail = $state('');
  let onboardRole = $state('user');
  let onboardElevated = $state(false);
  let onboardedApiKey = $state('');
  let onboardMode = $state<'new' | 'existing'>('new');
  let existingUsers = $state<UserInfo[]>([]);
  let selectedUserId = $state('');

  // Per-field saving state
  let saving: Record<string, boolean> = $state({});
  let feedback: Record<string, { msg: string; ok: boolean }> = $state({});

  function getVal(dotPath: string): unknown {
    if (!config) return undefined;
    const parts = dotPath.split('.');
    let current: unknown = config;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  function setLocalVal(dotPath: string, value: unknown) {
    if (!config) return;
    const parts = dotPath.split('.');
    let current: Record<string, unknown> = config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]] || typeof current[parts[i]] !== 'object') current[parts[i]] = {};
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
    config = { ...config };
  }

  async function saveField(dotPath: string, value: unknown) {
    saving[dotPath] = true;
    feedback[dotPath] = undefined as unknown as { msg: string; ok: boolean };
    try {
      await updateConfig(dotPath, value);
      setLocalVal(dotPath, value);
      feedback[dotPath] = { msg: 'Saved', ok: true };
    } catch (e: unknown) {
      feedback[dotPath] = { msg: e instanceof Error ? e.message : 'Failed', ok: false };
    } finally {
      saving[dotPath] = false;
    }
  }

  async function saveToggle(dotPath: string, currentValue: boolean) {
    const newValue = !currentValue;
    saving[dotPath] = true;
    feedback[dotPath] = undefined as unknown as { msg: string; ok: boolean };
    try {
      await updateConfig(dotPath, newValue);
      setLocalVal(dotPath, newValue);
      feedback[dotPath] = { msg: 'Saved', ok: true };
      // Reload channel status after toggle
      setTimeout(loadStatus, 1000);
    } catch (e: unknown) {
      feedback[dotPath] = { msg: e instanceof Error ? e.message : 'Failed', ok: false };
    } finally {
      saving[dotPath] = false;
    }
  }

  async function loadStatus() {
    try {
      const data = await getChannelsStatus();
      telegram = data.telegram;
      whatsapp = data.whatsapp;
      error = null;
    } catch (e: any) {
      error = e.message || 'Failed to load channel status';
    } finally {
      loading = false;
    }
  }

  async function loadQR() {
    try {
      const data = await getWhatsAppQR();
      qrDataUrl = data.qrDataUrl;
      if (data.status) {
        whatsapp.status = data.status;
        if (data.status === 'connected') await loadStatus();
      }
    } catch { /* non-critical */ }
  }

  function requestUnpair() {
    if (confirmUnpair) {
      performUnpair();
      return;
    }
    confirmUnpair = true;
    if (confirmUnpairTimer) clearTimeout(confirmUnpairTimer);
    confirmUnpairTimer = setTimeout(() => { confirmUnpair = false; }, 3000);
  }

  async function performUnpair() {
    confirmUnpair = false;
    if (confirmUnpairTimer) clearTimeout(confirmUnpairTimer);
    unpairing = true;
    try {
      await unpairWhatsApp();
      whatsapp.status = 'disconnected';
      whatsapp.phone = null;
      whatsapp.name = null;
      qrDataUrl = null;
    } catch (e: any) {
      error = e.message || 'Unpair failed';
    } finally {
      unpairing = false;
    }
  }

  async function handleSaveBotToken() {
    if (!botTokenInput.trim()) return;
    savingToken = true;
    tokenMsg = '';
    telegramTestResult = null;
    try {
      await saveChannelCredentials('telegram', { botToken: botTokenInput.trim() });
      botTokenInput = '';
      showTokenForm = false;

      // If Telegram is already enabled, restart it by toggling off then on
      if (getVal('channels.telegram.enabled')) {
        tokenMsg = 'Token saved. Reconnecting...';
        await updateConfig('channels.telegram.enabled', false);
        await new Promise(r => setTimeout(r, 500));
        await updateConfig('channels.telegram.enabled', true);
        tokenMsg = 'Token saved. Telegram reconnected.';
        setTimeout(loadStatus, 1500);
      } else {
        tokenMsg = 'Token saved. Enable Telegram to connect.';
      }
      setTimeout(() => { tokenMsg = ''; }, 5000);
    } catch (e: unknown) {
      tokenMsg = e instanceof Error ? e.message : 'Failed to save';
    } finally {
      savingToken = false;
    }
  }

  // AllowFrom helpers
  function formatList(arr: unknown): string {
    if (!Array.isArray(arr)) return '';
    return arr.map(String).join(', ');
  }

  function parseList(text: string): string[] {
    return text.split(',').map(s => s.trim()).filter(Boolean);
  }

  async function saveList(dotPath: string, values: string[]) {
    const list = values;
    saving[dotPath] = true;
    feedback[dotPath] = undefined as unknown as { msg: string; ok: boolean };
    try {
      await updateConfig(dotPath, list);
      setLocalVal(dotPath, list);
      feedback[dotPath] = { msg: 'Saved', ok: true };
    } catch (e: unknown) {
      feedback[dotPath] = { msg: e instanceof Error ? e.message : 'Failed', ok: false };
    } finally {
      saving[dotPath] = false;
    }
  }

  // Telegram test connection — uses input value if editing, otherwise tests saved token
  async function handleTestTelegram(tokenOverride?: string) {
    testingTelegram = true;
    telegramTestResult = null;
    tokenMsg = '';
    try {
      telegramTestResult = await testTelegramBot(tokenOverride || undefined);
    } catch (e: unknown) {
      telegramTestResult = { success: false, error: e instanceof Error ? e.message : 'Test failed' };
    } finally {
      testingTelegram = false;
    }
  }

  // Pending senders
  async function loadPendingSenders() {
    try {
      const data = await getPendingSenders() as { senders: PendingSender[]; counts?: { pending: number; seen: number } };
      pendingSenders = data.senders || [];
      senderCounts = data.counts || { pending: 0, seen: 0 };
    } catch { /* non-critical */ }
  }

  async function handleApproveSender(id: number) {
    approvingId = id;
    try {
      await approveSender(id);
      pendingSenders = pendingSenders.filter(s => s.id !== id);
      // Reload config so allowFrom field and warnings update
      const configData = await getConfig().catch(() => ({ config: null }));
      if (configData.config) config = configData.config;
    } catch { /* non-critical */ }
    approvingId = null;
  }

  async function handleRejectSender(id: number) {
    rejectingId = id;
    try {
      await rejectSender(id);
      pendingSenders = pendingSenders.filter(s => s.id !== id);
    } catch { /* non-critical */ }
    rejectingId = null;
  }

  async function startOnboard(sender: PendingSender) {
    onboardSenderData = sender;
    onboardName = sender.sender_name || '';
    onboardEmail = '';
    onboardRole = 'user';
    onboardElevated = false;
    onboardedApiKey = '';
    onboardMode = 'new';
    selectedUserId = '';
    // Load existing users for "Link to existing" option
    try { existingUsers = await getUsers(); } catch { existingUsers = []; }
  }

  async function handleOnboard() {
    if (!onboardSenderData) return;

    if (onboardMode === 'existing') {
      // Link to existing user: approve + pass userId
      if (!selectedUserId) return;
      try {
        await approveSender(onboardSenderData.id, selectedUserId);
        pendingSenders = pendingSenders.filter(s => s.id !== onboardSenderData!.id);
        const configData = await getConfig().catch(() => ({ config: null }));
        if (configData.config) config = configData.config;
        onboardSenderData = null;
      } catch (e: any) {
        error = e.message || 'Link failed';
      }
    } else {
      // Create new user + approve + link
      if (!onboardName.trim()) return;
      try {
        const result = await onboardSender(onboardSenderData.id, {
          name: onboardName.trim(),
          email: onboardEmail.trim() || undefined,
          role: onboardRole,
          elevated: onboardElevated,
        });
        onboardedApiKey = result.api_key;
        pendingSenders = pendingSenders.filter(s => s.id !== onboardSenderData!.id);
        const configData = await getConfig().catch(() => ({ config: null }));
        if (configData.config) config = configData.config;
      } catch (e: any) {
        error = e.message || 'Onboard failed';
      }
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  function startPolling() {
    pollInterval = setInterval(async () => {
      await loadStatus();
      await loadPendingSenders();
      if (whatsapp.enabled && (whatsapp.status === 'qr' || whatsapp.status === 'disconnected')) {
        await loadQR();
      } else {
        qrDataUrl = null;
      }
    }, 5000);
  }

  onMount(async () => {
    const [configData] = await Promise.all([
      getConfig().catch(() => ({ config: null })),
      loadStatus(),
      loadPendingSenders(),
    ]);
    config = configData.config;
    if (whatsapp.enabled && (whatsapp.status === 'qr' || whatsapp.status === 'disconnected')) {
      await loadQR();
    }
    startPolling();
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
  });
</script>

<svelte:head>
  <title>Channels - Admin - Kairo</title>
</svelte:head>

<div class="channels-page">
  <div class="page-header">
    <h1 class="page-title">Channels</h1>
    <p class="page-desc">Enable, configure, and monitor messaging channels.</p>
  </div>

  {#if loading}
    <div class="loading"><span class="spinner"></span> Loading channels...</div>
  {:else}

    <!-- ─── Pending Approvals (rejected senders) ──────────── -->
    {#if pendingSenders.filter(s => s.status === 'pending').length > 0}
      <div class="card pending-card">
        <div class="pending-header">
          <span class="pending-dot"></span>
          <strong>{senderCounts.pending} Pending Approval{senderCounts.pending > 1 ? 's' : ''}</strong>
          <span class="pending-hint">Blocked by allowlist{senderCounts.pending > 50 ? ` (showing 50 of ${senderCounts.pending})` : ''}</span>
        </div>
        <div class="pending-list">
          {#each pendingSenders.filter(s => s.status === 'pending') as sender (sender.id)}
            <div class="pending-row">
              <div class="pending-info">
                <span class="pending-name">
                  {#if (sender.channel === 'telegram' && sender.sender_id.startsWith('-')) || (sender.channel === 'whatsapp' && sender.sender_id.endsWith('@g.us'))}
                    <span class="badge badge-group">Group</span>
                  {/if}
                  {sender.sender_name || sender.sender_id}
                </span>
                <span class="pending-meta">
                  {sender.channel} &middot; ID: <code>{sender.sender_id}</code> &middot; {sender.message_count} msg{sender.message_count > 1 ? 's' : ''} &middot; {new Date(sender.last_seen).toLocaleDateString()}
                </span>
              </div>
              <div class="pending-actions">
                <button class="btn btn-sm btn-accent" onclick={() => startOnboard(sender)}>
                  Onboard
                </button>
                <button class="btn btn-sm btn-primary" disabled={approvingId === sender.id} onclick={() => handleApproveSender(sender.id)}>
                  {approvingId === sender.id ? 'Adding...' : 'Approve Only'}
                </button>
                <button class="btn btn-sm" disabled={rejectingId === sender.id} onclick={() => handleRejectSender(sender.id)}>
                  Dismiss
                </button>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- ─── Discovered Users (seen senders, no allowlist set) ──────────── -->
    {#if pendingSenders.filter(s => s.status === 'seen').length > 0}
      <div class="card discovered-card">
        <div class="pending-header">
          <strong>Discovered Users</strong>
          <span class="pending-hint">People who have messaged your bot.{senderCounts.seen > 50 ? ` Showing 50 of ${senderCounts.seen}.` : ''} Add to allowlist to restrict access.</span>
        </div>
        <div class="pending-list">
          {#each pendingSenders.filter(s => s.status === 'seen') as sender (sender.id)}
            <div class="pending-row">
              <div class="pending-info">
                <span class="pending-name">
                  {#if (sender.channel === 'telegram' && sender.sender_id.startsWith('-')) || (sender.channel === 'whatsapp' && sender.sender_id.endsWith('@g.us'))}
                    <span class="badge badge-group">Group</span>
                  {/if}
                  {sender.sender_name || sender.sender_id}
                </span>
                <span class="pending-meta">
                  {sender.channel} &middot; ID: <code>{sender.sender_id}</code> &middot; {sender.message_count} msg{sender.message_count > 1 ? 's' : ''} &middot; {new Date(sender.last_seen).toLocaleDateString()}
                </span>
              </div>
              <div class="pending-actions">
                <button class="btn btn-sm btn-accent" onclick={() => startOnboard(sender)}>
                  Onboard
                </button>
                <button class="btn btn-sm btn-primary" disabled={approvingId === sender.id} onclick={() => handleApproveSender(sender.id)}>
                  {approvingId === sender.id ? 'Adding...' : 'Add to allowlist'}
                </button>
                <button class="btn btn-sm" disabled={rejectingId === sender.id} onclick={() => handleRejectSender(sender.id)}>
                  Dismiss
                </button>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- ─── Onboard Modal ──────────── -->
    {#if onboardSenderData}
      <div class="modal-overlay" onclick={() => { if (!onboardedApiKey) onboardSenderData = null; }} role="presentation">
        <div class="modal card" onclick={(e) => e.stopPropagation()} role="dialog">
          {#if onboardedApiKey}
            <h2 class="modal-title">User Onboarded</h2>
            <p style="margin-bottom: 12px;">Save this API key now. It will not be shown again.</p>
            <div class="key-display">
              <code class="key-value">{onboardedApiKey}</code>
            </div>
            <div class="modal-actions">
              <button class="btn btn-primary" onclick={() => copyToClipboard(onboardedApiKey)}>Copy</button>
              <button class="btn" onclick={() => { onboardSenderData = null; onboardedApiKey = ''; }}>Done</button>
            </div>
          {:else}
            <h2 class="modal-title">Onboard User</h2>
            <p class="onboard-sender-info">
              <span class="badge badge-{onboardSenderData.channel}">{onboardSenderData.channel}</span>
              {onboardSenderData.sender_name || onboardSenderData.sender_id}
              <code>{onboardSenderData.sender_id}</code>
            </p>

            <!-- Tab selector -->
            <div class="onboard-tabs">
              <button class="tab" class:active={onboardMode === 'new'} onclick={() => onboardMode = 'new'}>Create New User</button>
              {#if existingUsers.length > 0}
                <button class="tab" class:active={onboardMode === 'existing'} onclick={() => onboardMode = 'existing'}>Link to Existing</button>
              {/if}
            </div>

            {#if onboardMode === 'new'}
              <div class="form-group">
                <label class="label">Name *</label>
                <input class="input" type="text" bind:value={onboardName} placeholder="User name" />
              </div>
              <div class="form-group">
                <label class="label">Email</label>
                <input class="input" type="email" bind:value={onboardEmail} placeholder="Optional" />
              </div>
              <div class="form-group">
                <label class="label">Role</label>
                <select class="input" bind:value={onboardRole}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={onboardElevated} />
                  Elevated (access to exec, cron, file write/delete)
                </label>
              </div>
              <div class="modal-actions">
                <button class="btn" onclick={() => onboardSenderData = null}>Cancel</button>
                <button class="btn btn-primary" onclick={handleOnboard} disabled={!onboardName.trim()}>Create & Approve</button>
              </div>
            {:else}
              <div class="form-group">
                <label class="label">Select User</label>
                <select class="input" bind:value={selectedUserId}>
                  <option value="">-- Select a user --</option>
                  {#each existingUsers.filter(u => u.active) as u}
                    <option value={u.id}>{u.name}{u.email ? ` (${u.email})` : ''} — {u.sender_links.map(l => `${l.channel_type}:${l.sender_id}`).join(', ') || 'no links'}</option>
                  {/each}
                </select>
              </div>
              <p class="text-muted" style="font-size: 12px;">This will link {onboardSenderData.channel} sender "{onboardSenderData.sender_name || onboardSenderData.sender_id}" to the selected user account and add to allowlist.</p>
              <div class="modal-actions">
                <button class="btn" onclick={() => onboardSenderData = null}>Cancel</button>
                <button class="btn btn-primary" onclick={handleOnboard} disabled={!selectedUserId}>Link & Approve</button>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/if}

    <!-- ─── Telegram ────────────────────────── -->
    <div class="channel-section">
      <div class="channel-header">
        <div class="channel-icon tg-icon">TG</div>
        <div class="channel-header-text">
          <h2 class="channel-name">Telegram</h2>
          <p class="channel-subtitle">Grammy bot integration</p>
        </div>
        <span class="status-badge" class:connected={telegram.enabled && telegram.connected} class:disconnected={telegram.enabled && !telegram.connected} class:disabled={!telegram.enabled}>
          <span class="status-dot"></span>
          {#if !telegram.enabled}Disabled{:else if telegram.connected}Connected{:else}Disconnected{/if}
        </span>
      </div>

      <div class="card channel-card">
        <!-- Enable toggle -->
        <div class="field-row">
          <div class="field-info">
            <label class="field-label">Enabled</label>
          </div>
          <div class="field-control">
            <button
              class="toggle-btn"
              class:active={!!getVal('channels.telegram.enabled')}
              role="switch"
              aria-checked={!!getVal('channels.telegram.enabled')}
              disabled={!!saving['channels.telegram.enabled']}
              onclick={() => saveToggle('channels.telegram.enabled', !!getVal('channels.telegram.enabled'))}
            >
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">{getVal('channels.telegram.enabled') ? 'On' : 'Off'}</span>
            </button>
          </div>
        </div>

        <!-- Bot token -->
        <div class="field-row">
          <div class="field-info">
            <label class="field-label">Bot Token</label>
            <span class="field-hint">From <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a></span>
          </div>
          <div class="field-control">
            {#if !showTokenForm}
              {#if telegram.hasToken}
                <span class="token-masked mono">{telegram.tokenHint || '****'}****</span>
              {/if}
              <button class="btn btn-sm" onclick={() => { showTokenForm = true; telegramTestResult = null; }}>
                {telegram.hasToken ? 'Edit Token' : 'Set Token'}
              </button>
              {#if telegram.hasToken && !telegram.connected}
                <button class="btn btn-sm" onclick={() => handleTestTelegram()} disabled={testingTelegram}>
                  {testingTelegram ? 'Testing...' : 'Test'}
                </button>
              {/if}
            {:else}
              <div class="inline-form">
                <input type={showBotToken ? 'text' : 'password'} class="input input-sm" bind:value={botTokenInput} placeholder="123456:ABC-..." />
                <button class="btn btn-xs" type="button" onclick={() => showBotToken = !showBotToken}>
                  {showBotToken ? 'Hide' : 'Show'}
                </button>
                <button class="btn btn-sm btn-primary" onclick={handleSaveBotToken} disabled={savingToken}>
                  {savingToken ? 'Saving...' : 'Save'}
                </button>
                <button class="btn btn-sm" onclick={() => handleTestTelegram(botTokenInput.trim())} disabled={testingTelegram || !botTokenInput.trim()}>
                  {testingTelegram ? '...' : 'Test'}
                </button>
                <button class="btn btn-sm" onclick={() => { showTokenForm = false; }}>Cancel</button>
              </div>
            {/if}
          </div>
        </div>
        {#if tokenMsg || telegramTestResult}
          <div class="token-feedback-row">
            {#if tokenMsg}<span class="field-msg" class:ok={tokenMsg.includes('saved')}>{tokenMsg}</span>{/if}
            {#if telegramTestResult}
              {#if telegramTestResult.success}
                <span class="test-ok">Connected as @{telegramTestResult.username}</span>
              {:else}
                <span class="test-err">{telegramTestResult.error}</span>
              {/if}
            {/if}
          </div>
        {/if}

        <!-- Status info -->
        {#if telegram.enabled && telegram.connected}
          <div class="field-row">
            <label class="field-label">Bot Username</label>
            <span class="field-value mono">@{telegram.botUsername}</span>
          </div>
          <div class="channel-hint success">
            Your bot is live. Message <a href="https://t.me/{telegram.botUsername}" target="_blank" rel="noopener noreferrer">@{telegram.botUsername}</a> on Telegram to chat.
          </div>
        {:else if telegram.enabled && !telegram.connected}
          <div class="channel-hint warn">
            {#if telegram.hasToken}
              Telegram is enabled but not connected. Try clicking "Test" to verify the token, or save the token again to reconnect.
            {:else}
              Telegram is enabled but no bot token is set. Add a token from @BotFather above.
            {/if}
          </div>
        {:else}
          <div class="channel-hint">
            Set a bot token from <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a>, then enable to connect.
          </div>
        {/if}

        <!-- Security warning: open bot -->
        {#if getVal('channels.telegram.enabled') && (!getVal('channels.telegram.allowFrom') || (Array.isArray(getVal('channels.telegram.allowFrom')) && (getVal('channels.telegram.allowFrom') as unknown[]).length === 0))}
          <div class="open-warning">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
              <line x1="12" y1="9" x2="12" y2="13"></line>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
            <span><strong>Open access</strong> — anyone can message this bot. Add yourself to Allowed Users to restrict access.</span>
          </div>
        {/if}

        <!-- Group settings (only when enabled) -->
        {#if getVal('channels.telegram.enabled')}
          <div class="subsettings">
            <div class="field-row">
              <div class="field-info">
                <label class="field-label">Groups</label>
                <span class="field-hint">Allow group conversations</span>
              </div>
              <div class="field-control">
                <button class="toggle-btn" class:active={!!getVal('channels.telegram.groupsEnabled')}
                  role="switch"
                  aria-checked={!!getVal('channels.telegram.groupsEnabled')}
                  disabled={!!saving['channels.telegram.groupsEnabled']}
                  onclick={() => saveToggle('channels.telegram.groupsEnabled', !!getVal('channels.telegram.groupsEnabled'))}>
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  <span class="toggle-label">{getVal('channels.telegram.groupsEnabled') ? 'On' : 'Off'}</span>
                </button>
              </div>
            </div>
            <div class="field-row">
              <div class="field-info">
                <label class="field-label">Require Mention</label>
                <span class="field-hint">Only respond when @mentioned or replied to</span>
              </div>
              <div class="field-control">
                <button class="toggle-btn" class:active={!!getVal('channels.telegram.groupRequireMention')}
                  role="switch"
                  aria-checked={!!getVal('channels.telegram.groupRequireMention')}
                  disabled={!!saving['channels.telegram.groupRequireMention']}
                  onclick={() => saveToggle('channels.telegram.groupRequireMention', !!getVal('channels.telegram.groupRequireMention'))}>
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  <span class="toggle-label">{getVal('channels.telegram.groupRequireMention') ? 'Yes' : 'No'}</span>
                </button>
              </div>
            </div>
            <!-- Group Require AllowFrom -->
            <div class="field-row">
              <div class="field-info">
                <label class="field-label">Require User Allowlist in Groups</label>
                <span class="field-hint">Only respond to users who are in the Allowed Users list, even inside allowed groups.</span>
              </div>
              <div class="field-control">
                <button class="toggle-btn" class:active={!!getVal('channels.telegram.groupRequireAllowFrom')}
                  role="switch"
                  aria-checked={!!getVal('channels.telegram.groupRequireAllowFrom')}
                  disabled={!!saving['channels.telegram.groupRequireAllowFrom']}
                  onclick={() => saveToggle('channels.telegram.groupRequireAllowFrom', !!getVal('channels.telegram.groupRequireAllowFrom'))}>
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  <span class="toggle-label">{getVal('channels.telegram.groupRequireAllowFrom') ? 'Yes' : 'No'}</span>
                </button>
              </div>
            </div>
            <!-- Group AllowFrom -->
            <div class="field-row allow-from-row">
              <div class="field-info">
                <label class="field-label">Allowed Groups</label>
                <span class="field-hint">Restrict which groups the bot responds in. Leave empty to allow all groups.</span>
              </div>
              <div class="field-control chip-field-control">
                <ChipInput
                  value={Array.isArray(getVal('channels.telegram.groupAllowFrom')) ? (getVal('channels.telegram.groupAllowFrom') as string[]).map(String) : []}
                  placeholder="e.g. -1003564949686"
                  onchange={(v) => saveList('channels.telegram.groupAllowFrom', v)}
                />
                {#if saving['channels.telegram.groupAllowFrom']}<span class="spinner-sm"></span>{/if}
                {#if feedback['channels.telegram.groupAllowFrom']?.msg}
                  <span class="field-msg" class:ok={feedback['channels.telegram.groupAllowFrom'].ok}>{feedback['channels.telegram.groupAllowFrom'].msg}</span>
                {/if}
              </div>
            </div>
            <!-- AllowFrom -->
            <div class="field-row allow-from-row">
              <div class="field-info">
                <label class="field-label">Allowed Users</label>
                <span class="field-hint">Restrict who can talk to your bot. Leave empty to allow everyone.</span>
              </div>
              <div class="field-control chip-field-control">
                <ChipInput
                  value={Array.isArray(getVal('channels.telegram.allowFrom')) ? (getVal('channels.telegram.allowFrom') as string[]).map(String) : []}
                  placeholder="e.g. 110432895"
                  onchange={(v) => saveList('channels.telegram.allowFrom', v)}
                />
                {#if saving['channels.telegram.allowFrom']}<span class="spinner-sm"></span>{/if}
                {#if feedback['channels.telegram.allowFrom']?.msg}
                  <span class="field-msg" class:ok={feedback['channels.telegram.allowFrom'].ok}>{feedback['channels.telegram.allowFrom'].msg}</span>
                {/if}
              </div>
            </div>
            <div class="allow-from-help">
              <p class="allow-from-alt">
                Easiest way: leave this empty, message your bot, then click <strong>Add to allowlist</strong> on the <strong>Discovered Users</strong> card above. Or paste IDs manually &mdash; message <a href="https://t.me/userinfobot" target="_blank" rel="noopener noreferrer">@userinfobot</a> to find yours.
              </p>
            </div>
            <!-- Outbound Security -->
            <div class="field-row">
              <div class="field-info">
                <label class="field-label">Outbound Policy</label>
                <span class="field-hint">Controls who the bot can send messages TO</span>
              </div>
              <div class="field-control">
                <select class="input input-sm"
                  value={getVal('channels.telegram.outboundPolicy') || 'session-only'}
                  onchange={(e) => saveField('channels.telegram.outboundPolicy', (e.target as HTMLSelectElement).value)}>
                  <option value="session-only">Session only (contacts who messaged first)</option>
                  <option value="unrestricted">Unrestricted</option>
                </select>
                {#if saving['channels.telegram.outboundPolicy']}<span class="spinner-sm"></span>{/if}
                {#if feedback['channels.telegram.outboundPolicy']?.msg}
                  <span class="field-msg" class:ok={feedback['channels.telegram.outboundPolicy'].ok}>{feedback['channels.telegram.outboundPolicy'].msg}</span>
                {/if}
              </div>
            </div>
            {#if getVal('channels.telegram.outboundPolicy') === 'session-only'}
              <div class="field-row">
                <div class="field-info">
                  <label class="field-label">Outbound Allowlist</label>
                  <span class="field-hint">Extra chat IDs the bot can message (beyond active sessions)</span>
                </div>
                <div class="field-control chip-field-control">
                  <ChipInput
                    value={Array.isArray(getVal('channels.telegram.outboundAllowlist')) ? (getVal('channels.telegram.outboundAllowlist') as string[]).map(String) : []}
                    placeholder="e.g. -1001234567890"
                    onchange={(v) => saveList('channels.telegram.outboundAllowlist', v)}
                  />
                  {#if saving['channels.telegram.outboundAllowlist']}<span class="spinner-sm"></span>{/if}
                  {#if feedback['channels.telegram.outboundAllowlist']?.msg}
                    <span class="field-msg" class:ok={feedback['channels.telegram.outboundAllowlist'].ok}>{feedback['channels.telegram.outboundAllowlist'].msg}</span>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Setup Guide (P1-1) -->
        <div class="collapsible-help">
          <details>
            <summary>Setup Guide</summary>
            <div class="setup-guide">
              <h4 class="guide-section-title">1. Create a bot</h4>
              <ol class="setup-steps">
                <li>Open Telegram and message <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a></li>
                <li>Send <code>/newbot</code>, pick a name and username</li>
                <li>Copy the bot token (looks like <code>123456:ABC-DEF...</code>)</li>
                <li>Paste it above using "Set Token", then click "Test" to verify</li>
              </ol>

              <h4 class="guide-section-title">2. Enable and restrict access</h4>
              <ol class="setup-steps">
                <li>Turn on the <strong>Enabled</strong> toggle above</li>
                <li>Send a message to your bot on Telegram</li>
                <li>Come back here &mdash; your name and ID appear under <strong>Discovered Users</strong></li>
                <li>Click <strong>Add to allowlist</strong> &mdash; now only you can use the bot</li>
              </ol>
            </div>
          </details>
        </div>
      </div>
    </div>

    <!-- ─── WhatsApp ────────────────────────── -->
    <div class="channel-section">
      <div class="channel-header">
        <div class="channel-icon wa-icon">WA</div>
        <div class="channel-header-text">
          <h2 class="channel-name">WhatsApp</h2>
          <p class="channel-subtitle">Baileys QR-code pairing</p>
        </div>
        <span class="status-badge" class:connected={whatsapp.status === 'connected'} class:pairing={whatsapp.status === 'qr'} class:disconnected={whatsapp.enabled && whatsapp.status === 'disconnected'} class:disabled={!whatsapp.enabled || whatsapp.status === 'disabled'}>
          <span class="status-dot"></span>
          {#if !whatsapp.enabled || whatsapp.status === 'disabled'}Disabled
          {:else if whatsapp.status === 'connected'}Connected
          {:else if whatsapp.status === 'qr'}Pairing...
          {:else}Disconnected{/if}
        </span>
      </div>

      <div class="card channel-card">
        <!-- Enable toggle -->
        <div class="field-row">
          <div class="field-info">
            <label class="field-label">Enabled</label>
          </div>
          <div class="field-control">
            <button
              class="toggle-btn"
              class:active={!!getVal('channels.whatsapp.enabled')}
              role="switch"
              aria-checked={!!getVal('channels.whatsapp.enabled')}
              disabled={!!saving['channels.whatsapp.enabled']}
              onclick={() => saveToggle('channels.whatsapp.enabled', !!getVal('channels.whatsapp.enabled'))}
            >
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">{getVal('channels.whatsapp.enabled') ? 'On' : 'Off'}</span>
            </button>
          </div>
        </div>

        <!-- Connection info -->
        {#if whatsapp.enabled && whatsapp.status === 'connected'}
          <div class="field-row">
            <label class="field-label">Phone</label>
            <span class="field-value mono">+{whatsapp.phone}</span>
          </div>
          {#if whatsapp.name}
            <div class="field-row">
              <label class="field-label">Name</label>
              <span class="field-value">{whatsapp.name}</span>
            </div>
          {/if}
        {/if}

        <!-- Security warning: open bot -->
        {#if getVal('channels.whatsapp.enabled') && (!getVal('channels.whatsapp.allowFrom') || (Array.isArray(getVal('channels.whatsapp.allowFrom')) && (getVal('channels.whatsapp.allowFrom') as unknown[]).length === 0))}
          <div class="open-warning">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
              <line x1="12" y1="9" x2="12" y2="13"></line>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
            <span><strong>Open access</strong> — anyone who messages your number gets an AI response. Add your phone to Allowed Phones to restrict access.</span>
          </div>
        {/if}

        <!-- Sub-settings (only when enabled) -->
        {#if getVal('channels.whatsapp.enabled')}
          <div class="subsettings">
            <div class="field-row">
              <div class="field-info">
                <label class="field-label">Groups</label>
                <span class="field-hint">Allow group conversations</span>
              </div>
              <div class="field-control">
                <button class="toggle-btn" class:active={!!getVal('channels.whatsapp.groupsEnabled')}
                  role="switch"
                  aria-checked={!!getVal('channels.whatsapp.groupsEnabled')}
                  disabled={!!saving['channels.whatsapp.groupsEnabled']}
                  onclick={() => saveToggle('channels.whatsapp.groupsEnabled', !!getVal('channels.whatsapp.groupsEnabled'))}>
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  <span class="toggle-label">{getVal('channels.whatsapp.groupsEnabled') ? 'On' : 'Off'}</span>
                </button>
              </div>
            </div>
            <div class="field-row">
              <div class="field-info">
                <label class="field-label">Require Mention</label>
                <span class="field-hint">Only respond when mentioned in groups</span>
              </div>
              <div class="field-control">
                <button class="toggle-btn" class:active={!!getVal('channels.whatsapp.groupRequireMention')}
                  role="switch"
                  aria-checked={!!getVal('channels.whatsapp.groupRequireMention')}
                  disabled={!!saving['channels.whatsapp.groupRequireMention']}
                  onclick={() => saveToggle('channels.whatsapp.groupRequireMention', !!getVal('channels.whatsapp.groupRequireMention'))}>
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  <span class="toggle-label">{getVal('channels.whatsapp.groupRequireMention') ? 'Yes' : 'No'}</span>
                </button>
              </div>
            </div>
            <div class="field-row">
              <div class="field-info">
                <label class="field-label">Read Receipts</label>
                <span class="field-hint">Send blue ticks for read messages</span>
              </div>
              <div class="field-control">
                <button class="toggle-btn" class:active={!!getVal('channels.whatsapp.sendReadReceipts')}
                  role="switch"
                  aria-checked={!!getVal('channels.whatsapp.sendReadReceipts')}
                  disabled={!!saving['channels.whatsapp.sendReadReceipts']}
                  onclick={() => saveToggle('channels.whatsapp.sendReadReceipts', !!getVal('channels.whatsapp.sendReadReceipts'))}>
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  <span class="toggle-label">{getVal('channels.whatsapp.sendReadReceipts') ? 'Yes' : 'No'}</span>
                </button>
              </div>
            </div>
            <!-- AllowFrom -->
            <div class="field-row">
              <div class="field-info">
                <label class="field-label">Allowed Phones</label>
                <span class="field-hint">Restrict who can DM your bot. Leave empty to allow everyone.</span>
              </div>
              <div class="field-control chip-field-control">
                <ChipInput
                  value={Array.isArray(getVal('channels.whatsapp.allowFrom')) ? (getVal('channels.whatsapp.allowFrom') as string[]).map(String) : []}
                  placeholder="e.g. 971501234567"
                  onchange={(v) => saveList('channels.whatsapp.allowFrom', v)}
                />
                {#if saving['channels.whatsapp.allowFrom']}<span class="spinner-sm"></span>{/if}
                {#if feedback['channels.whatsapp.allowFrom']?.msg}
                  <span class="field-msg" class:ok={feedback['channels.whatsapp.allowFrom'].ok}>{feedback['channels.whatsapp.allowFrom'].msg}</span>
                {/if}
              </div>
            </div>
            <div class="allow-from-help">
              <p class="allow-from-alt">
                Phone numbers without + or spaces (e.g. <code>971501234567</code>). Easiest way: leave empty, message your bot from WhatsApp, then click <strong>Add to allowlist</strong> on the <strong>Discovered Users</strong> card above.
              </p>
            </div>
            <div class="field-row">
              <div class="field-info">
                <label class="field-label">Require User Allowlist in Groups</label>
                <span class="field-hint">Only respond to users who are in the Allowed Users list, even inside allowed groups.</span>
              </div>
              <div class="field-control">
                <button class="toggle-btn" class:active={!!getVal('channels.whatsapp.groupRequireAllowFrom')}
                  role="switch"
                  aria-checked={!!getVal('channels.whatsapp.groupRequireAllowFrom')}
                  disabled={!!saving['channels.whatsapp.groupRequireAllowFrom']}
                  onclick={() => saveToggle('channels.whatsapp.groupRequireAllowFrom', !!getVal('channels.whatsapp.groupRequireAllowFrom'))}>
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  <span class="toggle-label">{getVal('channels.whatsapp.groupRequireAllowFrom') ? 'Yes' : 'No'}</span>
                </button>
              </div>
            </div>
            <div class="field-row">
              <div class="field-info">
                <label class="field-label">Allowed Groups</label>
                <span class="field-hint">Restrict which groups the bot responds in. Leave empty to allow all.</span>
              </div>
              <div class="field-control chip-field-control">
                <ChipInput
                  value={Array.isArray(getVal('channels.whatsapp.groupAllowFrom')) ? (getVal('channels.whatsapp.groupAllowFrom') as string[]).map(String) : []}
                  placeholder="Group JIDs"
                  onchange={(v) => saveList('channels.whatsapp.groupAllowFrom', v)}
                />
                {#if saving['channels.whatsapp.groupAllowFrom']}<span class="spinner-sm"></span>{/if}
                {#if feedback['channels.whatsapp.groupAllowFrom']?.msg}
                  <span class="field-msg" class:ok={feedback['channels.whatsapp.groupAllowFrom'].ok}>{feedback['channels.whatsapp.groupAllowFrom'].msg}</span>
                {/if}
              </div>
            </div>
            <div class="allow-from-help">
              <p class="allow-from-alt">
                Group JIDs are auto-filled when you approve groups. You typically don't need to set this manually.
              </p>
            </div>
            <!-- Outbound Security -->
            <div class="field-row">
              <div class="field-info">
                <label class="field-label">Outbound Policy</label>
                <span class="field-hint">Controls who the bot can send messages TO</span>
              </div>
              <div class="field-control">
                <select class="input input-sm"
                  value={getVal('channels.whatsapp.outboundPolicy') || 'session-only'}
                  onchange={(e) => saveField('channels.whatsapp.outboundPolicy', (e.target as HTMLSelectElement).value)}>
                  <option value="session-only">Session only (contacts who messaged first)</option>
                  <option value="unrestricted">Unrestricted</option>
                </select>
                {#if saving['channels.whatsapp.outboundPolicy']}<span class="spinner-sm"></span>{/if}
                {#if feedback['channels.whatsapp.outboundPolicy']?.msg}
                  <span class="field-msg" class:ok={feedback['channels.whatsapp.outboundPolicy'].ok}>{feedback['channels.whatsapp.outboundPolicy'].msg}</span>
                {/if}
              </div>
            </div>
            {#if getVal('channels.whatsapp.outboundPolicy') === 'session-only'}
              <div class="field-row">
                <div class="field-info">
                  <label class="field-label">Outbound Allowlist</label>
                  <span class="field-hint">Extra JIDs the bot can message (beyond active sessions)</span>
                </div>
                <div class="field-control chip-field-control">
                  <ChipInput
                    value={Array.isArray(getVal('channels.whatsapp.outboundAllowlist')) ? (getVal('channels.whatsapp.outboundAllowlist') as string[]).map(String) : []}
                    placeholder="e.g. 6591234567@s.whatsapp.net"
                    onchange={(v) => saveList('channels.whatsapp.outboundAllowlist', v)}
                  />
                  {#if saving['channels.whatsapp.outboundAllowlist']}<span class="spinner-sm"></span>{/if}
                  {#if feedback['channels.whatsapp.outboundAllowlist']?.msg}
                    <span class="field-msg" class:ok={feedback['channels.whatsapp.outboundAllowlist'].ok}>{feedback['channels.whatsapp.outboundAllowlist'].msg}</span>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Hints -->
        {#if !whatsapp.enabled || whatsapp.status === 'disabled'}
          <div class="channel-hint">
            Enable WhatsApp to start QR code pairing.
          </div>
        {/if}

        <!-- Docker warning (P1-2) -->
        {#if whatsapp.enabled && whatsapp.status !== 'connected'}
          <div class="docker-warning">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            If running in Docker, mount <code>agw-data/</code> as a volume to persist WhatsApp sessions across restarts.
          </div>
        {/if}

        <!-- Setup Guide -->
        <div class="collapsible-help">
          <details>
            <summary>Setup Guide</summary>
            <div class="setup-guide">
              <h4 class="guide-section-title">1. Pair your phone</h4>
              <ol class="setup-steps">
                <li>Toggle <strong>Enabled</strong> to On above</li>
                <li>A QR code appears below this card</li>
                <li>On your phone: <strong>WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device</strong></li>
                <li>Scan the QR code &mdash; status changes to "Connected"</li>
              </ol>

              <h4 class="guide-section-title">2. Restrict access</h4>
              <ol class="setup-steps">
                <li>Send a message to your WhatsApp number from another phone</li>
                <li>Come back here &mdash; your number appears under <strong>Discovered Users</strong></li>
                <li>Click <strong>Add to allowlist</strong> &mdash; now only that number can trigger the bot</li>
              </ol>

              <h4 class="guide-section-title">Important</h4>
              <ul class="setup-steps">
                <li>WhatsApp uses <strong>your real phone number</strong> &mdash; the bot responds as you, not as a separate bot</li>
                <li>Consider using a <strong>dedicated SIM</strong> to keep your personal WhatsApp separate</li>
                <li>Linked devices expire if your phone is offline for ~14 days &mdash; you'll need to re-scan the QR</li>
              </ul>
            </div>
          </details>
        </div>
      </div>

      <!-- QR Code for pairing -->
      {#if whatsapp.enabled && (whatsapp.status === 'qr' || whatsapp.status === 'disconnected')}
        <div class="card qr-card">
          <h3 class="subsection-title">Pair Device</h3>
          {#if qrDataUrl}
            <div class="qr-container">
              <img src={qrDataUrl} alt="WhatsApp QR Code" class="qr-image" />
            </div>
            <p class="qr-instructions">Open WhatsApp on your phone, go to <strong>Linked Devices</strong>, and scan this QR code.</p>
          {:else if whatsapp.status === 'qr'}
            <p class="qr-loading"><span class="spinner"></span> Generating QR code...</p>
          {:else}
            <p class="qr-waiting">Waiting for QR code... The server will generate one shortly.</p>
          {/if}
        </div>
      {/if}

      <!-- Unpair -->
      {#if whatsapp.status === 'connected'}
        <div class="card action-card">
          <p class="action-desc">Disconnect WhatsApp and clear stored credentials.</p>
          <button class="btn btn-danger" aria-label={confirmUnpair ? 'Confirm disconnect WhatsApp' : 'Disconnect WhatsApp'} onclick={requestUnpair} disabled={unpairing}>
            {unpairing ? 'Disconnecting...' : confirmUnpair ? 'Confirm?' : 'Disconnect & Unpair'}
          </button>
        </div>
      {/if}
    </div>

  {/if}
</div>

<style>
  .channels-page { max-width: 700px; }
  .page-header { margin-bottom: 28px; }
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.3px; }
  .page-desc { color: var(--text-muted); font-size: 14px; }
  .loading { color: var(--text-muted); padding: 20px 0; display: flex; align-items: center; gap: 8px; }

  .channel-section { margin-bottom: 32px; }
  .channel-header { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
  .channel-icon { width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; color: #fff; flex-shrink: 0; }
  .tg-icon { background: linear-gradient(135deg, #2AABEE, #229ED9); }
  .wa-icon { background: linear-gradient(135deg, #25D366, #128C7E); }
  .channel-header-text { flex: 1; }
  .channel-name { font-size: 18px; font-weight: 600; margin-bottom: 2px; }
  .channel-subtitle { font-size: 12px; color: var(--text-muted); }

  .status-badge { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 20px; background: var(--bg-raised); border: 1px solid var(--border-subtle); }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
  .status-badge.connected .status-dot { background: var(--green); box-shadow: 0 0 6px rgba(52, 211, 153, 0.5); }
  .status-badge.connected { color: var(--green); border-color: rgba(52, 211, 153, 0.2); }
  .status-badge.pairing .status-dot { background: var(--yellow, #fbbf24); animation: pulse 2s infinite; }
  .status-badge.pairing { color: var(--yellow, #fbbf24); }
  .status-badge.disabled { color: var(--text-muted); }

  .channel-card { padding: 18px 22px; }
  .field-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border-subtle); }
  .field-row:last-child { border-bottom: none; }
  .field-info { display: flex; flex-direction: column; gap: 2px; }
  .field-label { font-size: 13px; font-weight: 500; color: var(--text-primary); }
  .field-hint { font-size: 11px; color: var(--text-muted); }
  .field-hint a { color: var(--accent); }
  .field-value { font-size: 13px; color: var(--text-secondary); }
  .field-control { display: flex; align-items: center; gap: 8px; }
  .field-msg { font-size: 11px; margin-left: 8px; }
  .field-msg.ok { color: var(--green); }
  .mono { font-family: var(--font-mono); }

  .subsettings { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--border-subtle); }

  .inline-form { display: flex; align-items: center; gap: 6px; }
  .inline-form .input-sm { max-width: 220px; width: 100%; padding: 5px 8px; font-size: 12px; font-family: var(--font-mono); background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-primary); }

  .toggle-btn { display: flex; align-items: center; gap: 8px; background: none; border: none; cursor: pointer; padding: 0; color: inherit; }
  .toggle-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .toggle-track { width: 36px; height: 20px; border-radius: 10px; background: var(--bg-void); border: 1px solid var(--border); position: relative; transition: background var(--duration) var(--ease); }
  .toggle-btn.active .toggle-track { background: var(--accent); border-color: var(--accent); }
  .toggle-thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--text-muted); transition: all var(--duration) var(--ease); }
  .toggle-btn.active .toggle-thumb { left: 18px; background: #fff; }
  .toggle-label { font-size: 12px; color: var(--text-secondary); min-width: 24px; }

  .channel-hint { font-size: 13px; color: var(--text-muted); padding: 12px 0 4px; line-height: 1.5; }
  .channel-hint a { color: var(--accent); }
  .channel-hint.success { color: var(--green); }
  .channel-hint.warn { color: var(--yellow, #fbbf24); }

  .qr-card { padding: 20px; text-align: center; margin-top: 12px; }
  .subsection-title { font-size: 14px; font-weight: 600; margin-bottom: 16px; }
  .qr-container { display: flex; justify-content: center; margin-bottom: 16px; }
  .qr-image { width: 260px; height: 260px; border-radius: 12px; border: 2px solid var(--border); }
  .qr-instructions { font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
  .qr-loading, .qr-waiting { font-size: 13px; color: var(--text-muted); display: flex; align-items: center; justify-content: center; gap: 8px; padding: 20px; }

  .action-card { padding: 16px 22px; margin-top: 12px; }
  .action-desc { font-size: 13px; color: var(--text-muted); margin-bottom: 12px; }

  .input-action { display: flex; align-items: center; gap: 6px; width: 100%; }
  .input-action .input-sm { flex: 1; min-width: min(180px, 100%); padding: 5px 8px; font-size: 12px; font-family: var(--font-mono); background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-primary); }
  .spinner-sm { width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ChipInput field control */
  .chip-field-control { flex-direction: column; align-items: flex-start; gap: 4px; min-width: min(240px, 100%); }

  /* Token display */
  .token-masked { font-size: 12px; color: var(--text-muted); letter-spacing: 0.5px; }
  .token-feedback-row { padding: 4px 0 6px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .test-ok { font-size: 12px; color: var(--green); font-weight: 500; }
  .test-err { font-size: 12px; color: var(--red); }

  /* Collapsible sections — unified style for Setup Guide + AllowFrom help */
  .collapsible-help, .allow-from-help { padding: 2px 0 4px; }
  .collapsible-help details, .allow-from-help details { font-size: 12px; color: var(--text-muted); }
  .collapsible-help summary, .allow-from-help summary { cursor: pointer; color: var(--accent); font-size: 12px; padding: 4px 0; }
  .collapsible-help summary:hover, .allow-from-help summary:hover { text-decoration: underline; }
  .collapsible-help code, .allow-from-help code { font-size: 11px; background: var(--bg-raised); padding: 1px 5px; border-radius: 3px; color: var(--text-primary); }
  .collapsible-help a, .allow-from-help a { color: var(--accent); }
  .allow-from-alt { font-size: 12px; color: var(--text-muted); margin: 6px 0 0; line-height: 1.5; }

  /* Setup guide content */
  .setup-guide { padding: 10px 0 4px; }
  .guide-section-title { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 14px 0 6px; }
  .guide-section-title:first-child { margin-top: 0; }
  .setup-steps { font-size: 13px; color: var(--text-secondary); padding-left: 20px; margin: 0 0 12px; line-height: 1.8; }
  .setup-steps code { font-size: 12px; background: var(--bg-raised); padding: 1px 5px; border-radius: 3px; color: var(--text-primary); }
  .setup-steps a { color: var(--accent); }

  /* Open access warning */
  .open-warning { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--red); padding: 10px 14px; margin: 8px 0 4px; background: var(--red-subtle); border: 1px solid rgba(244, 63, 94, 0.15); border-radius: var(--radius); line-height: 1.5; }
  .open-warning svg { flex-shrink: 0; margin-top: 1px; }

  /* Docker warning */
  .docker-warning { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--yellow, #fbbf24); padding: 10px 0 4px; line-height: 1.5; }
  .docker-warning code { font-size: 11px; background: var(--bg-raised); padding: 1px 4px; border-radius: 3px; }

  /* Pending senders */
  .pending-card { padding: 16px 22px; margin-bottom: 24px; border: 1px solid rgba(251, 191, 36, 0.2); background: rgba(251, 191, 36, 0.03); }
  .pending-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 13px; }
  .pending-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--yellow, #fbbf24); animation: pulse 2s infinite; flex-shrink: 0; }
  .pending-hint { color: var(--text-muted); font-weight: 400; margin-left: auto; font-size: 12px; }
  .pending-list { display: flex; flex-direction: column; gap: 8px; }
  .pending-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: var(--bg-raised); border-radius: var(--radius); border: 1px solid var(--border-subtle); }
  .pending-info { display: flex; flex-direction: column; gap: 2px; }
  .pending-name { font-size: 13px; font-weight: 500; }
  .badge-group { display: inline-block; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px; background: var(--accent, #6366f1); color: #fff; margin-right: 4px; vertical-align: middle; }
  .pending-meta { font-size: 11px; color: var(--text-muted); }
  .pending-meta code { font-size: 11px; background: var(--bg-void); padding: 1px 4px; border-radius: 3px; font-family: var(--font-mono); }
  .pending-actions { display: flex; gap: 6px; }
  .discovered-card { padding: 16px 22px; margin-bottom: 24px; border: 1px solid var(--border-subtle); }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  @media (max-width: 768px) {
    .page-title { font-size: 20px; }
    .page-desc { font-size: 13px; }
    .field-row { flex-direction: column; align-items: flex-start; gap: 8px; }
    .field-control { width: 100%; }
    .channel-card { padding: 14px 16px; }
    .inline-form { flex-wrap: wrap; }
    .qr-image { width: 100%; max-width: 260px; height: auto; }
    .pending-row { flex-direction: column; align-items: flex-start; gap: 8px; }
    .channel-header { flex-wrap: wrap; gap: 10px; }
    .input-action { flex-wrap: wrap; }
  }

  /* Onboard modal */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center; z-index: 100;
  }
  .modal { padding: 24px; min-width: 400px; max-width: 500px; }
  .modal-title { font-size: 18px; font-weight: 700; margin-bottom: 16px; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
  .form-group { margin-bottom: 14px; }
  .label { display: block; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.3px; }
  .checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
  .btn-accent { background: var(--accent); color: white; border-color: var(--accent); }
  .btn-accent:hover { background: var(--accent-hover); }
  .onboard-sender-info {
    display: flex; align-items: center; gap: 8px;
    background: var(--bg-raised); padding: 8px 12px; border-radius: var(--radius);
    margin-bottom: 16px; font-size: 13px;
  }
  .key-display {
    background: var(--bg-raised); padding: 12px 16px; border-radius: var(--radius);
    margin: 12px 0;
  }
  .key-value {
    font-family: var(--font-mono); font-size: 12px;
    display: block; word-break: break-all; padding: 4px 0;
  }
  .onboard-tabs {
    display: flex; gap: 0; margin-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    padding: 8px 16px; border: none; background: none; cursor: pointer;
    font-size: 13px; font-weight: 500; color: var(--text-muted);
    border-bottom: 2px solid transparent; transition: all var(--duration) var(--ease);
  }
  .tab:hover { color: var(--text-primary); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .text-muted { color: var(--text-muted); }
</style>
