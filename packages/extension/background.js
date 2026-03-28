/**
 * KairoClaw Browser Bridge — Chrome Extension Service Worker
 *
 * Connects to KairoClaw server via WebSocket.
 * Receives commands from the AI agent and executes them in the user's browser.
 * Sends results back to the server.
 */

let ws = null;
let serverUrl = '';
let apiKey = '';
let connected = false;
let agentTabIds = new Set(); // tabs opened by the agent
let intentionalDisconnect = false; // true when user clicks Disconnect
let reconnectDelay = 5000; // starts at 5s, doubles each retry, max 60s
let authFailed = false; // true when server rejects our API key — stop retrying

// ── Connection management ───────────────────────────────────

async function connect() {
  intentionalDisconnect = false;
  authFailed = false;
  reconnectDelay = 5000;
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const config = await chrome.storage.local.get(['serverUrl', 'apiKey']);
  serverUrl = config.serverUrl || '';
  apiKey = config.apiKey || '';

  if (!serverUrl || !apiKey) {
    updateStatus('not_configured');
    return;
  }

  const wsUrl = serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/browser-bridge';

  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    updateStatus('error');
    return;
  }

  ws.onopen = () => {
    // Authenticate
    ws.send(JSON.stringify({ type: 'auth', token: apiKey }));
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'auth.ok') {
        connected = true;
        reconnectDelay = 5000; // reset backoff on success
        updateStatus('connected');
        return;
      }
      if (msg.type === 'auth.error') {
        connected = false;
        authFailed = true; // stop auto-reconnect
        updateStatus('auth_failed');
        ws?.close();
        return;
      }

      // Command from agent
      if (msg.type === 'command') {
        // Track activity
        chrome.storage.local.set({ lastActionAt: new Date().toISOString() });
        const result = await executeCommand(msg);
        ws.send(JSON.stringify({
          type: 'result',
          id: msg.id,
          result,
        }));
      }
    } catch (e) {
      console.error('[KairoClaw] Message handling error:', e);
    }
  };

  ws.onclose = () => {
    connected = false;
    updateStatus('disconnected');
    if (!intentionalDisconnect && !authFailed) {
      // Exponential backoff: 5s, 10s, 20s, 40s, 60s max
      setTimeout(() => {
        updateStatus('connecting');
        connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    }
  };

  ws.onerror = () => {
    connected = false;
    updateStatus('error');
  };
}

function disconnect() {
  intentionalDisconnect = true;
  if (ws) {
    ws.close();
    ws = null;
  }
  connected = false;
  updateStatus('disconnected');
}

function updateStatus(status) {
  chrome.storage.local.set({ connectionStatus: status });
  // Update badge
  const badges = {
    connected: { text: 'ON', color: '#22c55e' },
    disconnected: { text: '', color: '#666' },
    not_configured: { text: '!', color: '#f59e0b' },
    auth_failed: { text: '!', color: '#ef4444' },
    error: { text: '!', color: '#ef4444' },
  };
  const badge = badges[status] || badges.disconnected;
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

// ── Command execution ───────────────────────────────────────

async function executeCommand(msg) {
  const { action, params } = msg;

  try {
    switch (action) {
      case 'navigate': {
        const url = params.url;
        // Show label on existing tab if we have one
        const existingTab = await getActiveAgentTab();
        if (existingTab) await showActionLabel(existingTab, `Navigating to ${new URL(url).hostname}...`).catch(() => {});
        if (!url) return { error: 'url is required' };

        // Check if we already have an agent-opened tab (never reuse user's tabs)
        let tab;
        let existingAgentTab = null;
        for (const tabId of [...agentTabIds].reverse()) {
          try {
            await chrome.tabs.get(tabId);
            existingAgentTab = tabId;
            break;
          } catch {
            agentTabIds.delete(tabId);
          }
        }

        if (existingAgentTab) {
          // Reuse existing agent tab
          tab = await chrome.tabs.update(existingAgentTab, { url, active: true });
        } else {
          // Open in a NEW WINDOW so user can see chat + browser side by side
          const win = await chrome.windows.create({ url, type: 'normal' });
          tab = win.tabs[0];
        }
        agentTabIds.add(tab.id);
        // Wait for page load
        await waitForTabLoad(tab.id, 30000);
        const updatedTab = await chrome.tabs.get(tab.id);
        return { success: true, tabId: tab.id, url: updatedTab.url || url };
      }

      case 'snapshot': {
        const tabId = params.tabId || await getActiveAgentTab();
        if (!tabId) return { error: 'No active tab. Navigate first.' };
        const snapshot = await getTabSnapshot(tabId);
        const tabInfo = await chrome.tabs.get(tabId);
        return { url: tabInfo.url, title: tabInfo.title, snapshot };
      }

      case 'screenshot': {
        { const t = params.tabId || await getActiveAgentTab(); if (t) await showActionLabel(t, 'Taking screenshot...').catch(() => {}); }
        const tabId = params.tabId || await getActiveAgentTab();
        if (!tabId) return { error: 'No active tab' };
        // Focus the tab's window first
        const tab = await chrome.tabs.get(tabId);
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.tabs.update(tabId, { active: true });
        await sleep(300); // let tab render
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 75 });
        return { success: true, screenshot: dataUrl };
      }

      case 'click': {
        const tabId = params.tabId || await getActiveAgentTab();
        if (!tabId) return { error: 'No active tab' };
        const ref = params.ref ?? null;
        const element = params.element ?? null;
        await highlightElement(tabId, ref, element, 'Clicking...');
        const result = await executeInTab(tabId, (ref, element) => {
          let el = null;
          if (ref) el = document.querySelector(`[data-kc-ref="${ref}"]`);
          if (!el && element) {
            for (const tag of ['button', 'a', 'input', '[role="button"]']) {
              for (const candidate of document.querySelectorAll(tag)) {
                const text = candidate.getAttribute('aria-label') || candidate.textContent?.trim() || '';
                if (text.toLowerCase().includes(element.toLowerCase())) { el = candidate; break; }
              }
              if (el) break;
            }
          }
          if (!el) return { error: `Element not found: ref=${ref}, text="${element}"` };
          el.click();
          return { success: true, clicked: el.tagName };
        }, [ref, element]);
        await sleep(1000);
        return result;
      }

      case 'type': {
        const tabId = params.tabId || await getActiveAgentTab();
        if (!tabId) return { error: 'No active tab' };
        const { text, submit } = params;
        const ref = params.ref ?? null;
        const element = params.element ?? null;
        await highlightElement(tabId, ref, element, 'Typing...');
        const result = await executeInTab(tabId, (ref, element, text) => {
          let el = null;
          if (ref) el = document.querySelector(`[data-kc-ref="${ref}"]`);
          if (!el && element) {
            for (const input of document.querySelectorAll('input, textarea, select')) {
              const name = input.getAttribute('aria-label') || input.getAttribute('placeholder') || input.getAttribute('name') || '';
              if (name.toLowerCase().includes(element.toLowerCase())) { el = input; break; }
            }
          }
          if (!el) return { error: `Element not found: ref=${ref}, text="${element}"` };
          el.focus();
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, typed: text.length };
        }, [ref, element, text]);
        if (submit && result.success) {
          await executeInTab(tabId, () => {
            const form = document.activeElement?.closest('form');
            if (form) form.submit();
            else document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }, []);
          await sleep(2000);
        }
        return result;
      }

      case 'fill': {
        const tabId = params.tabId || await getActiveAgentTab();
        if (!tabId) return { error: 'No active tab' };
        const fields = params.fields;
        if (!fields || !Array.isArray(fields)) return { error: 'fields array required' };
        const results = await executeInTab(tabId, (fields) => {
          const results = [];
          for (const { ref, value } of fields) {
            const el = document.querySelector(`[data-kc-ref="${ref}"]`);
            if (!el) { results.push(`ref=${ref}: not found`); continue; }
            el.focus();
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            results.push(`ref=${ref}: filled`);
          }
          return results;
        }, [fields]);
        return { success: true, results };
      }

      case 'scroll': {
        const tabId = params.tabId || await getActiveAgentTab();
        if (!tabId) return { error: 'No active tab' };
        const direction = params.direction || 'down';
        await showActionLabel(tabId, `Scrolling ${direction}...`).catch(() => {});
        await executeInTab(tabId, (direction) => {
          window.scrollBy(0, direction === 'up' ? -500 : 500);
        }, [direction]);
        return { success: true, direction };
      }

      case 'back': {
        const tabId = params.tabId || await getActiveAgentTab();
        if (!tabId) return { error: 'No active tab' };
        await showActionLabel(tabId, 'Going back...').catch(() => {});
        await chrome.tabs.goBack(tabId);
        await sleep(2000);
        const tab = await chrome.tabs.get(tabId);
        return { success: true, url: tab.url, title: tab.title };
      }

      case 'tabs': {
        const tabs = await chrome.tabs.query({});
        return {
          tabs: tabs.map(t => ({
            id: t.id,
            url: t.url,
            title: t.title,
            active: t.active,
            agentManaged: agentTabIds.has(t.id),
          })),
        };
      }

      case 'close_tab': {
        const tabId = params.tabId || await getActiveAgentTab();
        if (tabId) {
          agentTabIds.delete(tabId);
          await chrome.tabs.remove(tabId);
        }
        return { success: true };
      }

      case 'forms': {
        const tabId = params.tabId || await getActiveAgentTab();
        if (!tabId) return { error: 'No active tab' };
        return await executeInTab(tabId, () => {
          const forms = [];
          for (const form of document.querySelectorAll('form')) {
            const fields = [];
            let submitBtn = null;
            for (const el of form.querySelectorAll('input, textarea, select')) {
              const refAttr = el.getAttribute('data-kc-ref');
              if (!refAttr) continue;
              const type = el.type || el.tagName.toLowerCase();
              if (type === 'hidden') continue;
              if (type === 'submit') { submitBtn = { ref: parseInt(refAttr), text: el.value || 'Submit' }; continue; }
              const id = el.getAttribute('id');
              const safeId = id ? id.replace(/["\\]/g, '') : null;
              const labelEl = safeId ? document.querySelector(`label[for="${safeId}"]`) : null;
              fields.push({
                ref: parseInt(refAttr),
                type,
                label: labelEl?.textContent?.trim()?.slice(0, 60) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '',
                required: el.required || false,
                value: type === 'password' ? '[REDACTED]' : (el.value || ''),
              });
            }
            if (!submitBtn) {
              const btn = form.querySelector('button[type="submit"], button:not([type])');
              if (btn?.getAttribute('data-kc-ref')) {
                submitBtn = { ref: parseInt(btn.getAttribute('data-kc-ref')), text: btn.textContent?.trim()?.slice(0, 40) || 'Submit' };
              }
            }
            if (fields.length > 0) {
              forms.push({
                name: form.getAttribute('aria-label') || form.getAttribute('name') || `Form ${forms.length + 1}`,
                fields,
                submitButton: submitBtn,
              });
            }
          }
          return { forms, formCount: forms.length };
        }, []);
      }

      case 'ping':
        return { pong: true, agentTabs: [...agentTabIds] };

      default:
        return { error: `Unknown action: ${action}` };
    }
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// ── Visual feedback helpers ──────────────────────────────────

/**
 * Highlight an element and animate a cursor pointer to it.
 * Runs inside the page via chrome.scripting.executeScript.
 */
/** Inject highlight CSS into a tab (once per tab, CSP-proof via chrome.scripting.insertCSS) */
const highlightCssInjected = new Set();

async function injectHighlightCSS(tabId) {
  if (highlightCssInjected.has(tabId)) return;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      css: `
        @keyframes kc-highlight-pulse {
          0% { outline-color: rgba(239, 68, 68, 1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6); }
          50% { outline-color: rgba(239, 68, 68, 0.5); box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
          100% { outline-color: rgba(239, 68, 68, 1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6); }
        }
        .kc-highlight {
          outline: 4px solid #ef4444 !important;
          outline-offset: 3px !important;
          background-color: rgba(239, 68, 68, 0.08) !important;
          animation: kc-highlight-pulse 0.5s ease-in-out 3 !important;
          transition: outline 0.2s, background-color 0.2s !important;
          position: relative;
        }
        .kc-action-label {
          position: fixed;
          top: 12px;
          right: 12px;
          background: rgba(239, 68, 68, 0.95);
          color: white;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 13px;
          font-weight: 600;
          padding: 8px 16px;
          border-radius: 8px;
          z-index: 2147483647;
          pointer-events: none;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          animation: kc-label-fade 2s ease forwards;
        }
        @keyframes kc-label-fade {
          0% { opacity: 0; transform: translateY(-8px); }
          10% { opacity: 1; transform: translateY(0); }
          80% { opacity: 1; }
          100% { opacity: 0; }
        }
      `,
    });
    highlightCssInjected.add(tabId);
  } catch (e) {
    console.warn('[KairoClaw] Failed to inject CSS:', e.message);
  }
}

async function highlightElement(tabId, ref, element, actionName) {
  // Focus the agent window so user can see it
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch { /* ignore */ }

  // Inject CSS (once per tab)
  await injectHighlightCSS(tabId);

  const safeRef = ref ?? null;
  const safeElement = element ?? null;
  const safeAction = actionName ?? 'action';

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (ref, element, actionLabel) => {
        // Remove previous highlight + label
        document.querySelectorAll('.kc-highlight').forEach(el => el.classList.remove('kc-highlight'));
        document.querySelectorAll('.kc-action-label').forEach(el => el.remove());

        // Show action label in top-right corner
        const label = document.createElement('div');
        label.className = 'kc-action-label';
        label.textContent = `Kairo: ${actionLabel}`;
        document.body.appendChild(label);
        setTimeout(() => label.remove(), 2000);

        // Find target element
        let el = null;
        if (ref) el = document.querySelector(`[data-kc-ref="${ref}"]`);
        if (!el && element) {
          for (const tag of ['button', 'a', 'input', 'textarea', 'select', '[role="button"]']) {
            for (const candidate of document.querySelectorAll(tag)) {
              const text = candidate.getAttribute('aria-label') || candidate.textContent?.trim() || '';
              if (text.toLowerCase().includes(element.toLowerCase())) { el = candidate; break; }
            }
            if (el) break;
          }
        }
        if (!el) return;

        // Scroll into view and highlight
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('kc-highlight');

        // Remove after 2s
        setTimeout(() => el.classList.remove('kc-highlight'), 2000);
      },
      args: [safeRef, safeElement, safeAction],
    });
  } catch (e) {
    console.warn('[KairoClaw] Highlight failed:', e.message);
  }

  await sleep(1200);
}

/** Show a non-element action label (navigate, scroll, etc.) */
async function showActionLabel(tabId, text) {
  await injectHighlightCSS(tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (text) => {
        document.querySelectorAll('.kc-action-label').forEach(el => el.remove());
        const label = document.createElement('div');
        label.className = 'kc-action-label';
        label.textContent = `Kairo: ${text}`;
        document.body.appendChild(label);
        setTimeout(() => label.remove(), 2000);
      },
      args: [text],
    });
  } catch { /* non-critical */ }
}

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getActiveAgentTab() {
  // Return the most recently used agent-opened tab (NEVER use user's tabs)
  for (const tabId of [...agentTabIds].reverse()) {
    try {
      await chrome.tabs.get(tabId);
      return tabId;
    } catch {
      agentTabIds.delete(tabId);
    }
  }
  // No agent tab — return null (caller must handle)
  return null;
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.webNavigation.onCompleted.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(details) {
      if (details.tabId === tabId && details.frameId === 0) {
        clearTimeout(timeout);
        chrome.webNavigation.onCompleted.removeListener(listener);
        // Wait extra for JS rendering
        setTimeout(resolve, 1500);
      }
    }
    chrome.webNavigation.onCompleted.addListener(listener);
  });
}

async function executeInTab(tabId, func, args) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
    });
    return results[0]?.result;
  } catch (e) {
    console.warn('[KairoClaw] executeInTab failed:', e.message);
    return { error: `Script execution failed: ${e.message}` };
  }
}

async function getTabSnapshot(tabId) {
  // First, inject ref attributes
  const snapshot = await executeInTab(tabId, () => {
    const sections = [];
    const seen = new Set();
    let nextRef = 1;

    // Clear old refs
    document.querySelectorAll('[data-kc-ref]').forEach(el => el.removeAttribute('data-kc-ref'));

    // Interactive elements
    const interactive = [];
    const elements = document.querySelectorAll(
      'input, textarea, select, button, a[href], [role="button"], [role="tab"], ' +
      '[role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"]'
    );
    for (const el of elements) {
      if (seen.has(el) || interactive.length >= 100) break;
      seen.add(el);
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;

      const tag = el.tagName;
      const name = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.textContent?.trim().slice(0, 60) || '';
      const ref = nextRef++;
      el.setAttribute('data-kc-ref', String(ref));

      let desc;
      if (tag === 'INPUT') {
        if (el.type === 'hidden') { nextRef--; continue; }
        desc = `[ref=${ref}] [input type=${el.type || 'text'}] "${name}"`;
        if (el.type === 'password') desc += ' value="[REDACTED]"';
        else if (el.value) desc += ` value="${el.value.slice(0, 40)}"`;
      } else if (tag === 'TEXTAREA') {
        desc = `[ref=${ref}] [textarea] "${name}"`;
      } else if (tag === 'SELECT') {
        desc = `[ref=${ref}] [select] "${name}" value="${el.value}"`;
      } else if (tag === 'A') {
        desc = `[ref=${ref}] [link] "${name}"`;
      } else if (tag === 'BUTTON' || el.getAttribute('role') === 'button') {
        desc = `[ref=${ref}] [button] "${name}"`;
      } else {
        desc = `[ref=${ref}] [${el.getAttribute('role') || tag.toLowerCase()}] "${name}"`;
      }
      interactive.push(desc);
    }
    if (interactive.length) sections.push('INTERACTIVE ELEMENTS:\n' + interactive.join('\n'));

    // Page content
    const content = [];
    for (const h of document.querySelectorAll('h1, h2, h3, h4')) {
      const t = h.textContent?.trim().slice(0, 150);
      if (t) content.push(`[${h.tagName.toLowerCase()}] ${t}`);
      if (content.length >= 20) break;
    }
    for (const el of document.querySelectorAll('p, li, td, th, span[class*="price"], .a-price, .a-offscreen')) {
      if (content.length >= 80) break;
      const style = window.getComputedStyle(el);
      if (style.display === 'none') continue;
      const t = el.textContent?.trim().slice(0, 200);
      if (t && t.length > 3) content.push(t);
    }
    if (content.length) sections.push('PAGE CONTENT:\n' + content.join('\n'));

    return sections.join('\n\n') || '[Empty page]';
  }, []);

  return snapshot;
}

// ── Tab cleanup ─────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  agentTabIds.delete(tabId);
  highlightCssInjected.delete(tabId);
});

// ── Heartbeat: sync badge with actual WebSocket state ────────
// MV3 service workers can sleep — when they wake up, ws is null
// but storage still says 'connected'. This catches that.

setInterval(() => {
  const isAlive = ws && ws.readyState === WebSocket.OPEN && connected;
  chrome.storage.local.get(['connectionStatus'], (data) => {
    if (data.connectionStatus === 'connected' && !isAlive) {
      updateStatus('disconnected');
      // Try to reconnect if we have config
      if (!intentionalDisconnect && !authFailed) {
        connect();
      }
    }
  });
}, 30000); // check every 30s

// ── Auto-connect on startup ─────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  updateStatus('not_configured');
});

chrome.runtime.onStartup.addListener(() => {
  connect();
});

// Listen for config changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.serverUrl || changes.apiKey)) {
    disconnect();
    connect();
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'connect') {
    disconnect();
    connect();
    sendResponse({ ok: true });
  } else if (msg.type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
  } else if (msg.type === 'status') {
    const isAlive = ws && ws.readyState === WebSocket.OPEN && connected;
    sendResponse({ connected: isAlive });
  }
  return true; // keep message channel open for async
});
