<script lang="ts">
  import { login, testProvider, saveProviderCredentials } from '$lib/api';
  import { setUser } from '$lib/stores/auth.svelte';
  import { goto } from '$app/navigation';

  let step = $state(0);

  // Step 1: API key
  let apiKey = $state('');
  let authError = $state('');
  let authLoading = $state(false);

  // Step 2: Provider
  let providerKey = $state('');
  let providerLoading = $state(false);
  let providerError = $state('');
  let providerSuccess = $state(false);
  let providerModels = $state<Array<{ id: string; name: string }>>([]);

  async function handleLogin() {
    authError = '';
    authLoading = true;
    try {
      const result = await login(apiKey);
      setUser(result.user);
      step = 2;
    } catch (e: unknown) {
      authError = e instanceof Error ? e.message : 'Invalid API key';
    } finally {
      authLoading = false;
    }
  }

  async function handleTestProvider() {
    providerError = '';
    providerSuccess = false;
    providerLoading = true;
    try {
      const result = await testProvider({ provider: 'anthropic', apiKey: providerKey });
      if (result.success) {
        providerSuccess = true;
        providerModels = result.models || [];
        // Save the key
        await saveProviderCredentials('anthropic', { apiKey: providerKey });
      } else {
        providerError = result.error || 'Connection failed';
      }
    } catch (e: unknown) {
      providerError = e instanceof Error ? e.message : 'Test failed';
    } finally {
      providerLoading = false;
    }
  }

  function goToDashboard() {
    goto('/');
  }
</script>

<svelte:head>
  <title>Setup - Kairo</title>
</svelte:head>

<div class="setup-page">
  <div class="setup-bg-mesh"></div>
  <div class="setup-bg-glow"></div>

  <div class="setup-card">
    <!-- Progress dots -->
    <div class="progress-dots">
      {#each [0, 1, 2, 3] as i}
        <span class="dot" class:active={step === i} class:done={step > i}></span>
      {/each}
    </div>

    <!-- Step 0: Welcome -->
    {#if step === 0}
      <div class="step" >
        <div class="setup-logo">
          <div class="setup-logo-inner">A</div>
          <div class="setup-logo-glow"></div>
        </div>
        <h1 class="setup-title">Welcome to Kairo</h1>
        <p class="setup-desc">Your personal AI gateway. Let's get you set up in a few quick steps.</p>
        <button class="btn btn-primary setup-btn" onclick={() => { step = 1; }}>
          Get Started
        </button>
      </div>

    <!-- Step 1: API Key -->
    {:else if step === 1}
      <div class="step">
        <h2 class="step-title">Sign In</h2>
        <p class="step-desc">Enter your admin API key to continue.</p>
        <div class="step-field">
          <label class="label" for="setup-key">Admin API Key</label>
          <input
            id="setup-key"
            type="password"
            class="input"
            bind:value={apiKey}
            placeholder="agw_sk_..."
            autocomplete="off"
            disabled={authLoading}
            onkeydown={(e) => { if (e.key === 'Enter') handleLogin(); }}
          />
          <p class="step-field-hint">
            Check your server logs for the key printed under "FIRST RUN":
          </p>
          <ul class="step-field-hints">
            <li><strong>Docker:</strong> <code>docker logs kairo</code></li>
            <li><strong>Local:</strong> Check the terminal where you ran <code>startup.sh</code></li>
            <li><strong>Cloud (Railway, Render, RunPod):</strong> Set <code>AGW_ADMIN_KEY</code> in your platform's environment variables before deploying, then use that value here</li>
          </ul>
        </div>
        {#if authError}
          <div class="step-error">{authError}</div>
        {/if}
        <button class="btn btn-primary setup-btn" onclick={handleLogin} disabled={!apiKey.trim() || authLoading}>
          {authLoading ? 'Connecting...' : 'Continue'}
        </button>
      </div>

    <!-- Step 2: Provider -->
    {:else if step === 2}
      <div class="step">
        <h2 class="step-title">Connect a Provider</h2>
        <p class="step-desc">Add an API key for your LLM provider. You can configure more providers later in Settings.</p>
        <div class="step-field">
          <label class="label" for="setup-provider">Anthropic API Key</label>
          <input
            id="setup-provider"
            type="password"
            class="input"
            bind:value={providerKey}
            placeholder="sk-ant-..."
            autocomplete="off"
            disabled={providerLoading}
            onkeydown={(e) => { if (e.key === 'Enter') handleTestProvider(); }}
          />
        </div>
        {#if providerError}
          <div class="step-error">{providerError}</div>
        {/if}
        {#if providerSuccess}
          <div class="step-success">
            Connected! {providerModels.length > 0 ? `${providerModels.length} models available.` : ''}
          </div>
        {/if}
        <div class="step-actions">
          <button class="btn" onclick={() => { step = 3; }}>Skip</button>
          {#if providerSuccess}
            <button class="btn btn-primary setup-btn" onclick={() => { step = 3; }}>Continue</button>
          {:else}
            <button class="btn btn-primary setup-btn" onclick={handleTestProvider} disabled={!providerKey.trim() || providerLoading}>
              {providerLoading ? 'Testing...' : 'Test & Save'}
            </button>
          {/if}
        </div>
      </div>

    <!-- Step 3: Done -->
    {:else if step === 3}
      <div class="step">
        <div class="done-check">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
        </div>
        <h2 class="step-title">You're All Set!</h2>
        <p class="step-desc">Kairo is ready. You can configure channels, tools, and more from the admin dashboard.</p>
        <button class="btn btn-primary setup-btn" onclick={goToDashboard}>
          Go to Dashboard
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .setup-page {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    background: var(--bg-void);
    position: relative;
    overflow: hidden;
  }

  .setup-bg-mesh {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse 600px 400px at 30% 20%, rgba(99, 102, 241, 0.08) 0%, transparent 70%),
      radial-gradient(ellipse 500px 300px at 70% 80%, rgba(167, 139, 250, 0.06) 0%, transparent 70%),
      radial-gradient(ellipse 400px 400px at 50% 50%, rgba(45, 212, 191, 0.03) 0%, transparent 70%);
    pointer-events: none;
  }
  .setup-bg-glow {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 500px; height: 500px;
    background: radial-gradient(circle, rgba(99, 102, 241, 0.06) 0%, transparent 70%);
    pointer-events: none;
    animation: breathe 6s ease-in-out infinite;
  }

  .setup-card {
    width: 100%;
    max-width: 440px;
    padding: 48px 40px 36px;
    text-align: center;
    position: relative;
    z-index: 1;
    animation: fadeInScale 0.5s var(--ease);
  }

  .progress-dots {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-bottom: 36px;
  }
  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--border);
    transition: all 0.3s ease;
  }
  .dot.active {
    background: var(--accent);
    box-shadow: 0 0 8px rgba(99, 102, 241, 0.4);
    transform: scale(1.2);
  }
  .dot.done { background: var(--green); }

  .step { animation: fadeIn 0.3s ease; }

  .setup-logo {
    position: relative;
    width: 72px; height: 72px;
    margin: 0 auto 24px;
  }
  .setup-logo-inner {
    width: 72px; height: 72px;
    background: linear-gradient(135deg, var(--accent), #a78bfa, #818cf8);
    background-size: 200% 200%;
    animation: gradientShift 4s ease infinite;
    border-radius: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 30px; font-weight: 700;
    color: #fff;
    position: relative; z-index: 1;
    box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3);
  }
  .setup-logo-glow {
    position: absolute; inset: -8px;
    border-radius: 24px;
    background: radial-gradient(circle, rgba(99, 102, 241, 0.25) 0%, transparent 70%);
    animation: breathe 3s ease-in-out infinite;
    z-index: 0;
  }

  .setup-title { font-size: 26px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.5px; }
  .setup-desc { color: var(--text-muted); font-size: 14px; margin-bottom: 32px; line-height: 1.6; }

  .step-title { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
  .step-desc { color: var(--text-muted); font-size: 14px; margin-bottom: 24px; line-height: 1.6; }
  .step-field { text-align: left; margin-bottom: 20px; }
  .step-field .label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: var(--text-secondary); }
  .step-field-hint { font-size: 12px; color: var(--text-muted); margin-top: 10px; line-height: 1.5; }
  .step-field-hint code, .step-field-hints code { font-size: 11px; background: var(--bg-raised); padding: 2px 6px; border-radius: 3px; color: var(--text-primary); }
  .step-field-hints { font-size: 12px; color: var(--text-muted); margin: 6px 0 0; padding-left: 18px; line-height: 1.8; }
  .step-field-hints strong { color: var(--text-secondary); font-weight: 600; }

  .step-error {
    padding: 10px 14px;
    background: var(--red-subtle);
    border: 1px solid rgba(244, 63, 94, 0.2);
    border-radius: var(--radius);
    color: var(--red);
    font-size: 13px;
    margin-bottom: 16px;
    text-align: left;
  }
  .step-success {
    padding: 10px 14px;
    background: var(--green-subtle);
    border: 1px solid rgba(52, 211, 153, 0.2);
    border-radius: var(--radius);
    color: var(--green);
    font-size: 13px;
    margin-bottom: 16px;
    text-align: left;
  }

  .setup-btn { width: 100%; padding: 10px; font-size: 14px; font-weight: 600; }
  .step-actions { display: flex; gap: 10px; }
  .step-actions .btn { flex: 1; padding: 10px; font-size: 14px; }

  .done-check { margin-bottom: 20px; }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeInScale { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
  @keyframes breathe { 0%, 100% { opacity: 1; transform: translate(-50%, -50%) scale(1); } 50% { opacity: 0.6; transform: translate(-50%, -50%) scale(1.05); } }
  @keyframes gradientShift { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
</style>
