<script lang="ts">
  const downloadUrl = '/api/v1/admin/extension';

  let downloading = $state(false);

  async function handleDownload() {
    downloading = true;
    try {
      const token = localStorage.getItem('agw_api_key') || '';
      const res = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'kairoclaw-browser-bridge.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
    finally { downloading = false; }
  }
</script>

<svelte:head><title>Browser Extension - Admin - Kairo</title></svelte:head>

<div class="page">
  <div class="page-header">
    <h1 class="page-title">Browser Extension</h1>
    <p class="page-desc">Connect your real browser to KairoClaw — let the AI agent browse with your cookies and sessions.</p>
  </div>

  <div class="card">
    <h2 class="section-title">KairoClaw Browser Bridge</h2>
    <p class="section-desc">A Chrome extension that connects your browser to KairoClaw. When connected, the AI agent can open tabs, navigate pages, fill forms, and take screenshots in your real browser — using your logged-in sessions.</p>

    <button class="btn btn-primary" onclick={handleDownload} disabled={downloading}>
      {downloading ? 'Downloading...' : 'Download Extension (.zip)'}
    </button>
  </div>

  <div class="card">
    <h2 class="section-title">Installation</h2>
    <ol class="steps">
      <li>
        <strong>Download</strong> the extension ZIP above and unpack it to a folder
      </li>
      <li>
        Open <code>chrome://extensions</code> in Chrome
      </li>
      <li>
        Enable <strong>Developer mode</strong> (toggle in top-right corner)
      </li>
      <li>
        Click <strong>"Load unpacked"</strong> and select the unpacked folder
      </li>
      <li>
        Click the extension icon (puzzle piece) in Chrome toolbar and <strong>pin</strong> KairoClaw
      </li>
      <li>
        Click the extension icon, enter:
        <ul>
          <li><strong>Server URL:</strong> <code>{window.location.origin}</code></li>
          <li><strong>API Key:</strong> your personal API key</li>
        </ul>
      </li>
      <li>
        Click <strong>Connect</strong> — the badge should show <span class="badge-on">ON</span>
      </li>
    </ol>
  </div>

  <div class="card">
    <h2 class="section-title">How it works</h2>
    <div class="flow">
      <div class="flow-step">
        <div class="flow-icon">💬</div>
        <div class="flow-text">You chat with the AI agent as usual</div>
      </div>
      <div class="flow-arrow">→</div>
      <div class="flow-step">
        <div class="flow-icon">🌐</div>
        <div class="flow-text">Agent decides to browse a website</div>
      </div>
      <div class="flow-arrow">→</div>
      <div class="flow-step">
        <div class="flow-icon">🖥️</div>
        <div class="flow-text">A new window opens in YOUR Chrome</div>
      </div>
      <div class="flow-arrow">→</div>
      <div class="flow-step">
        <div class="flow-icon">🔴</div>
        <div class="flow-text">You see red highlights on elements the agent interacts with</div>
      </div>
    </div>
    <p class="note">When no extension is connected, the agent falls back to its built-in headless browser (no access to your cookies/sessions).</p>
  </div>

  <div class="card">
    <h2 class="section-title">Status</h2>
    <p class="section-desc">This feature is in <strong>beta</strong> and available to <strong>admin users only</strong>. The extension requires the <code>tabs</code> and <code>scripting</code> permissions to control browser tabs.</p>
  </div>
</div>

<style>
  .page { max-width: 800px; }
  .page-header { margin-bottom: 24px; }
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  .page-desc { color: var(--text-muted); font-size: 14px; }
  .card { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg, 12px); padding: 24px; margin-bottom: 16px; }
  .section-title { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
  .section-desc { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; line-height: 1.5; }
  .steps { padding-left: 20px; font-size: 13px; color: var(--text-secondary); line-height: 1.8; }
  .steps li { margin-bottom: 8px; }
  .steps code { background: var(--bg-raised); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  .steps ul { padding-left: 20px; margin-top: 4px; }
  .badge-on { display: inline-block; background: #22c55e; color: white; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
  .flow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .flow-step { display: flex; align-items: center; gap: 8px; background: var(--bg-raised); padding: 10px 14px; border-radius: 8px; font-size: 13px; }
  .flow-icon { font-size: 20px; }
  .flow-text { color: var(--text-secondary); }
  .flow-arrow { color: var(--text-muted); font-size: 18px; }
  .note { font-size: 12px; color: var(--text-muted); font-style: italic; }
  .btn { padding: 10px 20px; border: none; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; }
  .btn-primary { background: var(--accent, #6366f1); color: white; }
  .btn-primary:hover { opacity: 0.9; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  @media (max-width: 768px) {
    .flow { flex-direction: column; }
    .flow-arrow { transform: rotate(90deg); }
  }
</style>
