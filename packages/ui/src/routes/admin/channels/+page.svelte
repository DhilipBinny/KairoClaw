<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getConfig, getChannelsStatus, getWhatsAppQR, unpairWhatsApp, updateConfig, saveChannelCredentials } from '$lib/api';
  import Badge from '$lib/components/Badge.svelte';

  interface TelegramStatus {
    enabled: boolean;
    connected: boolean;
    botUsername: string | null;
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
  let showTokenForm = $state(false);
  let botTokenInput = $state('');
  let savingToken = $state(false);
  let tokenMsg = $state('');

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
    try {
      await saveChannelCredentials('telegram', { botToken: botTokenInput.trim() });
      tokenMsg = 'Bot token saved. Enable Telegram to connect.';
      botTokenInput = '';
      showTokenForm = false;
    } catch (e: unknown) {
      tokenMsg = e instanceof Error ? e.message : 'Failed to save';
    } finally {
      savingToken = false;
    }
  }

  function startPolling() {
    pollInterval = setInterval(async () => {
      await loadStatus();
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
            <span class="field-label">Enabled</span>
          </div>
          <div class="field-control">
            <button
              class="toggle-btn"
              class:active={!!getVal('channels.telegram.enabled')}
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
            <span class="field-label">Bot Token</span>
            <span class="field-hint">From <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a></span>
          </div>
          <div class="field-control">
            {#if !showTokenForm}
              <button class="btn btn-sm" aria-label={telegram.connected ? 'Change Telegram bot token' : 'Set Telegram bot token'} onclick={() => { showTokenForm = true; }}>
                {telegram.connected ? 'Change Token' : 'Set Token'}
              </button>
            {:else}
              <div class="inline-form">
                <input type="password" class="input input-sm" bind:value={botTokenInput} placeholder="123456:ABC-..." />
                <button class="btn btn-sm btn-primary" onclick={handleSaveBotToken} disabled={savingToken}>
                  {savingToken ? 'Saving...' : 'Save'}
                </button>
                <button class="btn btn-sm" onclick={() => { showTokenForm = false; }}>Cancel</button>
              </div>
            {/if}
            {#if tokenMsg}<span class="field-msg" class:ok={tokenMsg.includes('saved')}>{tokenMsg}</span>{/if}
          </div>
        </div>

        <!-- Status info -->
        {#if telegram.enabled && telegram.connected}
          <div class="field-row">
            <span class="field-label">Bot Username</span>
            <span class="field-value mono">@{telegram.botUsername}</span>
          </div>
          <div class="channel-hint success">
            Your bot is live. Message <a href="https://t.me/{telegram.botUsername}" target="_blank" rel="noopener noreferrer">@{telegram.botUsername}</a> on Telegram to chat.
          </div>
        {:else if telegram.enabled && !telegram.connected}
          <div class="channel-hint warn">
            Telegram is enabled but not connected. Make sure the bot token is set and valid.
          </div>
        {:else}
          <div class="channel-hint">
            Set a bot token from <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a>, then enable to connect.
          </div>
        {/if}

        <!-- Group settings (only when enabled) -->
        {#if getVal('channels.telegram.enabled')}
          <div class="subsettings">
            <div class="field-row">
              <div class="field-info">
                <span class="field-label">Groups</span>
                <span class="field-hint">Allow group conversations</span>
              </div>
              <div class="field-control">
                <button class="toggle-btn" class:active={!!getVal('channels.telegram.groupsEnabled')}
                  disabled={!!saving['channels.telegram.groupsEnabled']}
                  onclick={() => saveToggle('channels.telegram.groupsEnabled', !!getVal('channels.telegram.groupsEnabled'))}>
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  <span class="toggle-label">{getVal('channels.telegram.groupsEnabled') ? 'On' : 'Off'}</span>
                </button>
              </div>
            </div>
            <div class="field-row">
              <div class="field-info">
                <span class="field-label">Require Mention</span>
                <span class="field-hint">Only respond when @mentioned or replied to</span>
              </div>
              <div class="field-control">
                <button class="toggle-btn" class:active={!!getVal('channels.telegram.groupRequireMention')}
                  disabled={!!saving['channels.telegram.groupRequireMention']}
                  onclick={() => saveToggle('channels.telegram.groupRequireMention', !!getVal('channels.telegram.groupRequireMention'))}>
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  <span class="toggle-label">{getVal('channels.telegram.groupRequireMention') ? 'Yes' : 'No'}</span>
                </button>
              </div>
            </div>
          </div>
        {/if}
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
            <span class="field-label">Enabled</span>
          </div>
          <div class="field-control">
            <button
              class="toggle-btn"
              class:active={!!getVal('channels.whatsapp.enabled')}
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
            <span class="field-label">Phone</span>
            <span class="field-value mono">+{whatsapp.phone}</span>
          </div>
          {#if whatsapp.name}
            <div class="field-row">
              <span class="field-label">Name</span>
              <span class="field-value">{whatsapp.name}</span>
            </div>
          {/if}
        {/if}

        <!-- Sub-settings (only when enabled) -->
        {#if getVal('channels.whatsapp.enabled')}
          <div class="subsettings">
            <div class="field-row">
              <div class="field-info">
                <span class="field-label">Groups</span>
                <span class="field-hint">Allow group conversations</span>
              </div>
              <div class="field-control">
                <button class="toggle-btn" class:active={!!getVal('channels.whatsapp.groupsEnabled')}
                  disabled={!!saving['channels.whatsapp.groupsEnabled']}
                  onclick={() => saveToggle('channels.whatsapp.groupsEnabled', !!getVal('channels.whatsapp.groupsEnabled'))}>
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  <span class="toggle-label">{getVal('channels.whatsapp.groupsEnabled') ? 'On' : 'Off'}</span>
                </button>
              </div>
            </div>
            <div class="field-row">
              <div class="field-info">
                <span class="field-label">Require Mention</span>
                <span class="field-hint">Only respond when mentioned in groups</span>
              </div>
              <div class="field-control">
                <button class="toggle-btn" class:active={!!getVal('channels.whatsapp.groupRequireMention')}
                  disabled={!!saving['channels.whatsapp.groupRequireMention']}
                  onclick={() => saveToggle('channels.whatsapp.groupRequireMention', !!getVal('channels.whatsapp.groupRequireMention'))}>
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  <span class="toggle-label">{getVal('channels.whatsapp.groupRequireMention') ? 'Yes' : 'No'}</span>
                </button>
              </div>
            </div>
            <div class="field-row">
              <div class="field-info">
                <span class="field-label">Read Receipts</span>
                <span class="field-hint">Send blue ticks for read messages</span>
              </div>
              <div class="field-control">
                <button class="toggle-btn" class:active={!!getVal('channels.whatsapp.sendReadReceipts')}
                  disabled={!!saving['channels.whatsapp.sendReadReceipts']}
                  onclick={() => saveToggle('channels.whatsapp.sendReadReceipts', !!getVal('channels.whatsapp.sendReadReceipts'))}>
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  <span class="toggle-label">{getVal('channels.whatsapp.sendReadReceipts') ? 'Yes' : 'No'}</span>
                </button>
              </div>
            </div>
          </div>
        {/if}

        <!-- Hints -->
        {#if !whatsapp.enabled || whatsapp.status === 'disabled'}
          <div class="channel-hint">
            Enable WhatsApp to start QR code pairing.
          </div>
        {/if}
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
  .inline-form .input-sm { width: 220px; padding: 5px 8px; font-size: 12px; font-family: var(--font-mono); background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-primary); }

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

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
