const serverUrlInput = document.getElementById('serverUrl');
const apiKeyInput = document.getElementById('apiKey');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');

// Load saved config
chrome.storage.local.get(['serverUrl', 'apiKey', 'connectionStatus'], (data) => {
  if (data.serverUrl) serverUrlInput.value = data.serverUrl;
  if (data.apiKey) apiKeyInput.value = data.apiKey;
  updateUI(data.connectionStatus || 'disconnected');
});

// Listen for status changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.connectionStatus) {
    updateUI(changes.connectionStatus.newValue);
  }
});

function updateUI(status) {
  statusEl.className = 'status ' + (status === 'connected' ? 'connected' : status === 'error' || status === 'auth_failed' ? 'error' : 'disconnected');

  const labels = {
    connected: 'Connected to KairoClaw',
    disconnected: 'Disconnected',
    not_configured: 'Not configured',
    auth_failed: 'Authentication failed',
    error: 'Connection error',
  };
  statusText.textContent = labels[status] || 'Unknown';

  if (status === 'connected') {
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'block';
  } else {
    connectBtn.style.display = 'block';
    disconnectBtn.style.display = 'none';
  }
}

connectBtn.addEventListener('click', async () => {
  const serverUrl = serverUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();

  if (!serverUrl || !apiKey) {
    statusText.textContent = 'Please fill in both fields';
    return;
  }

  await chrome.storage.local.set({ serverUrl, apiKey });
  // Background script auto-reconnects on storage change
});

disconnectBtn.addEventListener('click', async () => {
  // Send disconnect message to background
  chrome.runtime.sendMessage({ type: 'disconnect' });
});

// Handle disconnect message in background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'disconnect') {
    // Background will handle this
  }
});
