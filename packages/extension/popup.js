const serverUrlInput = document.getElementById('serverUrl');
const apiKeyInput = document.getElementById('apiKey');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const dashboardBtn = document.getElementById('dashboardBtn');
const settingsBtn = document.getElementById('settingsBtn');
const toggleKeyBtn = document.getElementById('toggleKey');
const statusCard = document.getElementById('statusCard');
const statusLabel = document.getElementById('statusLabel');
const statusDetail = document.getElementById('statusDetail');
const settingsSection = document.getElementById('settingsSection');
const connectedActions = document.getElementById('connectedActions');
const activitySection = document.getElementById('activitySection');
const lastActivityEl = document.getElementById('lastActivity');

let showSettings = false;

// Load saved config
chrome.storage.local.get(['serverUrl', 'apiKey', 'connectionStatus', 'lastActionAt', 'actionCount'], (data) => {
  if (data.serverUrl) serverUrlInput.value = data.serverUrl;
  if (data.apiKey) apiKeyInput.value = data.apiKey;
  if (data.lastActionAt) lastActivityEl.textContent = timeAgo(data.lastActionAt);
  updateUI(data.connectionStatus || 'disconnected');
});

// Listen for status changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.connectionStatus) updateUI(changes.connectionStatus.newValue);
  if (changes.lastActionAt) lastActivityEl.textContent = timeAgo(changes.lastActionAt.newValue);
});

function updateUI(status) {
  // Status card
  statusCard.className = 'status-card ' + (status === 'connecting' ? 'connecting' : status === 'connected' ? 'connected' : status === 'error' || status === 'auth_failed' ? 'error' : 'disconnected');

  const labels = {
    connected: 'Connected',
    disconnected: 'Disconnected',
    not_configured: 'Not Configured',
    auth_failed: 'Auth Failed',
    error: 'Connection Error',
    connecting: 'Connecting...',
  };
  statusLabel.textContent = labels[status] || 'Unknown';

  // Detail text
  if (status === 'connected') {
    statusDetail.textContent = serverUrlInput.value.replace(/^https?:\/\//, '');
  } else if (status === 'auth_failed') {
    statusDetail.textContent = 'Invalid API key — check Settings';
  } else if (status === 'error') {
    statusDetail.textContent = 'Could not reach server';
  } else if (status === 'connecting') {
    statusDetail.textContent = 'Establishing connection...';
  } else if (status === 'not_configured') {
    statusDetail.textContent = 'Enter server URL and API key below';
  } else {
    statusDetail.textContent = 'Click Connect to start';
  }

  // Show/hide sections
  const isConnected = status === 'connected';
  connectedActions.classList.toggle('hidden', !isConnected);
  activitySection.classList.toggle('hidden', !isConnected);

  if (isConnected && !showSettings) {
    settingsSection.classList.add('hidden');
  } else {
    settingsSection.classList.remove('hidden');
  }
}

// Connect
connectBtn.addEventListener('click', async () => {
  const serverUrl = serverUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();

  // Validate inputs
  if (!serverUrl || !apiKey) {
    statusLabel.textContent = 'Fill in both fields';
    statusCard.className = 'status-card error';
    statusDetail.textContent = 'Server URL and API key are required';
    return;
  }
  if (!/^https?:\/\/.+/.test(serverUrl)) {
    statusLabel.textContent = 'Invalid URL';
    statusCard.className = 'status-card error';
    statusDetail.textContent = 'Must start with http:// or https://';
    return;
  }
  if (apiKey.length < 10) {
    statusLabel.textContent = 'Invalid API Key';
    statusCard.className = 'status-card error';
    statusDetail.textContent = 'API key is too short';
    return;
  }

  await chrome.storage.local.set({ serverUrl, apiKey, connectionStatus: 'connecting' });
  updateUI('connecting');
  chrome.runtime.sendMessage({ type: 'connect' });
  showSettings = false;
});

// Disconnect
disconnectBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' }, () => {
    updateUI('disconnected');
    showSettings = false;
  });
  chrome.storage.local.set({ connectionStatus: 'disconnected' });
});

// Dashboard
dashboardBtn.addEventListener('click', () => {
  const url = serverUrlInput.value.trim();
  if (url) chrome.tabs.create({ url: url + '/admin' });
});

// Settings toggle
settingsBtn.addEventListener('click', () => {
  showSettings = !showSettings;
  settingsSection.classList.toggle('hidden', !showSettings);
});

// Toggle API key visibility
toggleKeyBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleKeyBtn.textContent = isPassword ? '\u{1F441}' : '\u{1F512}';
});

// Time ago helper
function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
