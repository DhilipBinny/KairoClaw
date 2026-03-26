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

  // Save config
  await chrome.storage.local.set({ serverUrl, apiKey });
  // Explicitly tell background to connect
  chrome.runtime.sendMessage({ type: 'connect' });
  statusText.textContent = 'Connecting...';
});

disconnectBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' }, () => {
    // Update UI immediately
    updateUI('disconnected');
  });
  // Also update status in case service worker is slow
  chrome.storage.local.set({ connectionStatus: 'disconnected' });
});
