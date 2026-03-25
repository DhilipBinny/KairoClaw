<script lang="ts">
  import { onMount } from 'svelte';
  import { getScopes, getScopeDetail } from '$lib/api';
  import type { ScopeEntry } from '$lib/api';
  import Badge from '$lib/components/Badge.svelte';

  let scopes: ScopeEntry[] = $state([]);
  let loading = $state(true);
  let selectedScope: string | null = $state(null);
  let detail: { userMd: string; profile: string; sessions: Array<{ date: string; content: string }> } | null = $state(null);
  let loadingDetail = $state(false);

  async function loadScopes() {
    loading = true;
    try {
      const data = await getScopes();
      scopes = data.scopes;
    } catch (e) {
      console.error('Failed to load scopes:', e);
    } finally {
      loading = false;
    }
  }

  async function viewScope(key: string) {
    selectedScope = key;
    loadingDetail = true;
    detail = null;
    try {
      detail = await getScopeDetail(key);
    } catch (e) {
      console.error('Failed to load scope detail:', e);
    } finally {
      loadingDetail = false;
    }
  }

  function closeDetail() {
    selectedScope = null;
    detail = null;
  }

  function channelColor(channel: string): string {
    if (channel === 'telegram') return 'var(--blue)';
    if (channel === 'whatsapp') return 'var(--green)';
    return 'var(--text-secondary)';
  }

  onMount(loadScopes);
</script>

<div class="page">
  <div class="page-header">
    <h1>Scoped Channels</h1>
    <p class="subtitle">Per-user profiles, memory, and session history. Auto-managed by the agent.</p>
  </div>

  {#if loading}
    <div class="loading">Loading scoped channels...</div>
  {:else if scopes.length === 0}
    <div class="empty">
      <p>No scoped channels yet. Scopes are created automatically when someone messages the bot on Telegram or WhatsApp.</p>
    </div>
  {:else}
    <div class="layout" class:has-detail={selectedScope}>
      <!-- User list -->
      <div class="user-list">
        {#each scopes as scope (scope.scopeKey)}
          <button
            class="user-card"
            class:active={selectedScope === scope.scopeKey}
            onclick={() => viewScope(scope.scopeKey)}
          >
            <div class="user-card-header">
              {#if scope.scopeType === 'group'}
                <span class="scope-badge group">Group</span>
                <span class="channel-badge" style="color: {channelColor(scope.channel)}">{scope.channel}</span>
              {:else if scope.userName}
                <strong>{scope.userName}</strong>
              {:else}
                <span class="channel-badge" style="color: {channelColor(scope.channel)}">
                  {scope.channel}
                </span>
                <span class="user-id">{scope.userId}</span>
              {/if}
            </div>
            <div class="user-card-meta">
              {#if scope.sessionCount > 0}
                <span class="meta-item">{scope.sessionCount} sessions</span>
              {/if}
              {#if scope.lastSession}
                <span class="meta-item">Last: {scope.lastSession}</span>
              {/if}
              {#if scope.hasProfile}
                <Badge text="Profile" variant="success" />
              {/if}
            </div>
          </button>
        {/each}
      </div>

      <!-- Detail panel -->
      {#if selectedScope}
        <div class="detail-panel">
          <div class="detail-header">
            <h2>{selectedScope}</h2>
            <button class="close-btn" onclick={closeDetail}>&times;</button>
          </div>

          {#if loadingDetail}
            <div class="loading">Loading...</div>
          {:else if detail}
            <!-- USER.md -->
            {#if detail.userMd}
              <div class="detail-section">
                <h3>User Profile</h3>
                <pre class="content-block">{detail.userMd}</pre>
              </div>
            {/if}

            <!-- PROFILE.md -->
            {#if detail.profile}
              <div class="detail-section">
                <h3>Long-Term Memory</h3>
                <pre class="content-block">{detail.profile}</pre>
              </div>
            {:else}
              <div class="detail-section">
                <h3>Long-Term Memory</h3>
                <p class="empty-note">No profile yet. Consolidation runs daily to build this from session notes.</p>
              </div>
            {/if}

            <!-- Sessions -->
            {#if detail.sessions.length > 0}
              <div class="detail-section">
                <h3>Recent Sessions</h3>
                {#each detail.sessions as session (session.date)}
                  <details class="session-entry">
                    <summary>{session.date}</summary>
                    <pre class="content-block">{session.content}</pre>
                  </details>
                {/each}
              </div>
            {:else}
              <div class="detail-section">
                <h3>Recent Sessions</h3>
                <p class="empty-note">No session notes yet.</p>
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .page {
    max-width: 1200px;
  }
  .page-header {
    margin-bottom: 24px;
  }
  .page-header h1 {
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }
  .subtitle {
    font-size: 13px;
    color: var(--text-secondary);
    margin: 0;
  }
  .loading, .empty {
    text-align: center;
    padding: 40px;
    color: var(--text-secondary);
  }
  .layout {
    display: flex;
    gap: 20px;
  }
  .user-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 280px;
    max-width: 320px;
  }
  .layout.has-detail .user-list {
    max-width: 280px;
  }
  .user-card {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    padding: 12px 14px;
    cursor: pointer;
    transition: all var(--duration) var(--ease);
  }
  .user-card:hover {
    border-color: var(--border);
    background: var(--bg-raised);
  }
  .user-card.active {
    border-color: var(--accent);
    background: var(--bg-raised);
  }
  .user-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .channel-badge {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .scope-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 8px;
  }
  .scope-badge.group {
    background: #dbeafe;
    color: #2563eb;
  }
  .user-id {
    font-size: 13px;
    color: var(--text-primary);
    font-family: var(--font-mono);
  }
  .user-card-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .detail-panel {
    flex: 1;
    min-width: 0;
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    padding: 20px;
    max-height: calc(100vh - 140px);
    overflow-y: auto;
  }
  .detail-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }
  .detail-header h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
    font-family: var(--font-mono);
  }
  .close-btn {
    background: none;
    border: none;
    font-size: 20px;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: var(--radius);
  }
  .close-btn:hover {
    background: var(--bg-raised);
    color: var(--text-primary);
  }
  .detail-section {
    margin-bottom: 20px;
  }
  .detail-section h3 {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 8px;
  }
  .content-block {
    background: var(--bg-base);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    padding: 12px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
    margin: 0;
    font-family: var(--font-mono);
  }
  .empty-note {
    font-size: 12px;
    color: var(--text-secondary);
    font-style: italic;
    margin: 0;
  }
  .session-entry {
    margin-bottom: 8px;
  }
  .session-entry summary {
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
    padding: 6px 0;
  }
  .session-entry summary:hover {
    color: var(--accent);
  }

  @media (max-width: 768px) {
    .page-header h1 { font-size: 18px; }
    .layout {
      flex-direction: column;
    }
    .user-list {
      max-width: 100% !important;
      min-width: 0;
      max-height: 40vh;
      overflow-y: auto;
      flex-shrink: 0;
    }
    .detail-panel {
      max-height: none;
    }
    .detail-header h2 {
      font-size: 13px;
    }
    .content-block {
      font-size: 11px;
    }
  }
</style>
