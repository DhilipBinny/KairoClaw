<script lang="ts">
  import { login } from '$lib/api';
  import { setUser } from '$lib/stores/auth.svelte';
  import { goto } from '$app/navigation';

  let apiKey = $state('');
  let error = $state('');
  let loading = $state(false);

  async function handleLogin() {
    error = '';
    loading = true;

    try {
      const result = await login(apiKey);
      setUser(result.user);
      goto('/');
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : 'Failed to connect';
    } finally {
      loading = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleLogin();
    }
  }
</script>

<svelte:head>
  <title>Login - Kairo</title>
</svelte:head>

<div class="login-page">
  <!-- Background mesh -->
  <div class="login-bg-mesh"></div>
  <div class="login-bg-glow"></div>

  <div class="login-card">
    <div class="login-logo">
      <img src="/logo.png" alt="Kairo" class="login-logo-inner" />
      <div class="login-logo-glow"></div>
    </div>
    <h1 class="login-title">Kairo</h1>
    <p class="login-tagline">The secure gateway for your AI agents</p>

    <div class="login-form">
      <div class="login-field">
        <label class="label" for="apiKey">API Key</label>
        <div class="login-input-wrapper">
          <svg class="login-input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          <input
            id="apiKey"
            type="password"
            class="input login-input"
            bind:value={apiKey}
            onkeydown={handleKeydown}
            placeholder="agw_..."
            autocomplete="off"
            disabled={loading}
          />
        </div>
      </div>

      {#if error}
        <div class="login-error">{error}</div>
      {/if}

      <button
        class="btn btn-primary login-btn"
        onclick={handleLogin}
        disabled={!apiKey.trim() || loading}
      >
        {#if loading}
          <span class="spinner" style="width:14px;height:14px;border-width:2px;"></span>
          Connecting...
        {:else}
          Connect
        {/if}
      </button>
    </div>

    <p class="login-footer">Self-hosted AI agent gateway</p>
  </div>
</div>

<style>
  .login-page {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    background: var(--bg-void);
    position: relative;
    overflow: hidden;
  }

  /* Gradient mesh background */
  .login-bg-mesh {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse 600px 400px at 30% 20%, rgba(99, 102, 241, 0.08) 0%, transparent 70%),
      radial-gradient(ellipse 500px 300px at 70% 80%, rgba(167, 139, 250, 0.06) 0%, transparent 70%),
      radial-gradient(ellipse 400px 400px at 50% 50%, rgba(45, 212, 191, 0.03) 0%, transparent 70%);
    pointer-events: none;
  }

  .login-bg-glow {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 500px;
    height: 500px;
    background: radial-gradient(circle, rgba(99, 102, 241, 0.06) 0%, transparent 70%);
    pointer-events: none;
    animation: breathe 6s ease-in-out infinite;
  }

  .login-card {
    width: 100%;
    max-width: 400px;
    padding: 48px 40px 36px;
    text-align: center;
    position: relative;
    z-index: 1;
    animation: fadeInScale 0.5s var(--ease);
  }

  /* Logo with glow */
  .login-logo {
    position: relative;
    width: 72px;
    height: 72px;
    margin: 0 auto 24px;
  }
  .login-logo-inner {
    width: 72px;
    height: 72px;
    border-radius: 18px;
    object-fit: cover;
    position: relative;
    z-index: 1;
    box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3);
  }
  .login-logo-glow {
    position: absolute;
    inset: -8px;
    border-radius: 24px;
    background: radial-gradient(circle, rgba(99, 102, 241, 0.25) 0%, transparent 70%);
    animation: breathe 3s ease-in-out infinite;
    z-index: 0;
  }

  .login-title {
    font-size: 26px;
    font-weight: 700;
    margin-bottom: 6px;
    letter-spacing: -0.5px;
  }
  .login-tagline {
    color: var(--text-muted);
    font-size: 14px;
    margin-bottom: 36px;
  }
  .login-form {
    text-align: left;
  }
  .login-field {
    margin-bottom: 20px;
  }

  /* Input with icon */
  .login-input-wrapper {
    position: relative;
  }
  .login-input-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }
  .login-input {
    padding-left: 38px;
  }

  .login-error {
    padding: 10px 14px;
    background: var(--red-subtle);
    border: 1px solid rgba(244, 63, 94, 0.2);
    border-radius: var(--radius);
    color: var(--red);
    font-size: 13px;
    margin-bottom: 16px;
  }
  .login-btn {
    width: 100%;
    padding: 10px;
    font-size: 14px;
    font-weight: 600;
  }
  .login-footer {
    margin-top: 32px;
    font-size: 12px;
    color: var(--text-ghost);
    letter-spacing: 0.3px;
  }
</style>
