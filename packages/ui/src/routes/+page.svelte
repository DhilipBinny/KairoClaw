<script lang="ts">
  import { onMount } from 'svelte';
  import ChatMessage from '$lib/components/ChatMessage.svelte';
  import SessionList from '$lib/components/SessionList.svelte';
  import {
    getMessages,
    getIsStreaming,
    getError,
    getThinkingLabel,
    clearError,
    sendMessage,
    removeMessage,
    initChatListeners,
    destroyChatListeners,
    loadHistory,
    type ChatMessage as ChatMessageType,
  } from '$lib/stores/chat.svelte';
  import { initSessionListeners, destroySessionListeners, loadSessions } from '$lib/stores/sessions.svelte';
  import { logout } from '$lib/stores/auth.svelte';
  import { goto } from '$app/navigation';
  import * as ws from '$lib/ws';

  let messages = $derived(getMessages());
  let isStreaming = $derived(getIsStreaming());
  let error = $derived(getError());
  let thinkingLabel = $derived(getThinkingLabel());

  let inputText = $state('');
  let messageContainer: HTMLDivElement | undefined = $state();
  let inputRef: HTMLTextAreaElement | undefined = $state();
  let sidebarOpen = $state(true);

  function handleSend() {
    const text = inputText.trim();
    if (!text || isStreaming) return;
    sendMessage(text);
    inputText = '';
    // Reset textarea height
    if (inputRef) {
      inputRef.style.height = 'auto';
    }
  }

  function handleRetry(msg: ChatMessageType) {
    // For user messages: resend the same text
    // For error messages: find the preceding user message and resend it
    let textToRetry = '';
    if (msg.role === 'user') {
      textToRetry = msg.content;
      // Remove this message and any response after it
      removeMessage(msg.id);
    } else {
      // Find the last user message before this error
      const msgs = getMessages();
      const idx = msgs.findIndex((m) => m.id === msg.id);
      for (let i = idx - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          textToRetry = msgs[i].content;
          break;
        }
      }
      // Remove the error message
      removeMessage(msg.id);
    }
    if (textToRetry) {
      sendMessage(textToRetry);
    }
  }

  function handleDeleteMessage(msg: ChatMessageType) {
    removeMessage(msg.id);
    loadSessions(); // Refresh session list in case turns changed
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function autoResize(e: Event) {
    const target = e.target as HTMLTextAreaElement;
    target.style.height = 'auto';
    target.style.height = Math.min(target.scrollHeight, 200) + 'px';
  }

  // Auto-scroll to bottom when new messages arrive
  $effect(() => {
    if (messages.length > 0 && messageContainer) {
      requestAnimationFrame(() => {
        messageContainer?.scrollTo({ top: messageContainer.scrollHeight, behavior: 'smooth' });
      });
    }
  });

  onMount(() => {
    ws.connect().then(() => {
      initChatListeners();
      initSessionListeners();
      loadHistory();
    });

    return () => {
      destroyChatListeners();
      destroySessionListeners();
    };
  });
</script>

<svelte:head>
  <title>Chat - Kairo</title>
</svelte:head>

<div class="chat-layout">
  <!-- Sidebar -->
  <div class="sidebar" class:open={sidebarOpen}>
    <div class="sidebar-header">
      <a href="/" class="sidebar-brand">
        <img src="/logo.png" alt="Kairo" class="sidebar-logo" />
        <span class="sidebar-title">Kairo</span>
      </a>
    </div>
    <SessionList />
    <div class="sidebar-footer">
      <a href="/admin" class="sidebar-admin-link">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        Admin Dashboard
      </a>
      <button class="sidebar-signout" onclick={() => { logout(); goto('/login'); }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <polyline points="16 17 21 12 16 7"></polyline>
          <line x1="21" y1="12" x2="9" y2="12"></line>
        </svg>
        Sign Out
      </button>
    </div>
  </div>
  {#if sidebarOpen}
    <button class="sidebar-backdrop" onclick={() => sidebarOpen = false} aria-label="Close sidebar"></button>
  {/if}

  <!-- Main chat area -->
  <div class="chat-main" id="main-content">
    <!-- Header -->
    <div class="chat-header">
      <button class="btn btn-sm sidebar-toggle" onclick={() => sidebarOpen = !sidebarOpen} aria-label="Toggle sidebar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <line x1="3" y1="12" x2="21" y2="12"></line>
          <line x1="3" y1="18" x2="21" y2="18"></line>
        </svg>
      </button>
      <span class="chat-header-title">Chat</span>
      <div class="chat-header-actions">
        {#if isStreaming}
          <span class="streaming-indicator">
            <span class="streaming-dots">
              <span class="streaming-dot"></span>
              <span class="streaming-dot"></span>
              <span class="streaming-dot"></span>
            </span>
            Generating...
          </span>
        {/if}
      </div>
    </div>

    <!-- Messages -->
    <div class="chat-messages" bind:this={messageContainer} role="log" aria-live="polite" aria-label="Chat messages">
      {#if messages.length === 0}
        <div class="chat-empty">
          <div class="chat-empty-logo">
            <img src="/logo.png" alt="Kairo" class="chat-empty-logo-inner" />
            <div class="chat-empty-glow"></div>
          </div>
          <h2 class="chat-empty-title">Kairo</h2>
          <p class="chat-empty-subtitle">Your AI agent is ready. Send a message to start a conversation.</p>
          <div class="chat-quick-starts">
            <button class="chat-quick-btn" onclick={() => { inputText = 'What can you help me with?'; inputRef?.focus(); }}>
              What can you help me with?
            </button>
            <button class="chat-quick-btn" onclick={() => { inputText = 'Tell me about your available tools'; inputRef?.focus(); }}>
              Available tools
            </button>
            <button class="chat-quick-btn" onclick={() => { inputText = 'What is your current configuration?'; inputRef?.focus(); }}>
              Current configuration
            </button>
          </div>
        </div>
      {:else}
        {#each messages as msg (msg.id)}
          <ChatMessage message={msg} onRetry={handleRetry} onDelete={handleDeleteMessage} />
        {/each}
      {/if}

      {#if error}
        <div class="chat-error" role="alert">
          <span class="chat-error-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="15" y1="9" x2="9" y2="15"></line>
              <line x1="9" y1="9" x2="15" y2="15"></line>
            </svg>
          </span>
          <span>{error}</span>
          <button class="btn btn-sm" onclick={clearError}>Dismiss</button>
        </div>
      {/if}

      {#if thinkingLabel}
        <div class="thinking-shimmer">
          <span class="spinner"></span> {thinkingLabel}
        </div>
      {/if}
    </div>

    <!-- Input -->
    <div class="chat-input-area">
      <div class="chat-input-wrapper">
        <textarea
          class="chat-input"
          bind:this={inputRef}
          bind:value={inputText}
          onkeydown={handleKeydown}
          oninput={autoResize}
          placeholder="Send a message..."
          rows="1"
          disabled={isStreaming}
        ></textarea>
        <button
          class="chat-send-btn"
          onclick={handleSend}
          disabled={!inputText.trim() || isStreaming}
          aria-label="Send message"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .chat-layout {
    display: flex;
    height: 100vh;
    width: 100%;
  }

  /* Sidebar */
  .sidebar {
    width: var(--sidebar-width);
    background: var(--bg-surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  .sidebar-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    text-decoration: none;
    color: var(--text-primary);
  }
  .sidebar-logo {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    flex-shrink: 0;
    object-fit: contain;
  }
  .sidebar-title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.3px;
  }
  .sidebar-footer {
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .sidebar-admin-link {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--radius);
    font-size: 13px;
    color: var(--text-secondary);
    text-decoration: none;
    transition: all var(--duration) var(--ease);
  }
  .sidebar-admin-link:hover {
    background: var(--bg-raised);
    color: var(--text-primary);
  }
  .sidebar-signout {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--radius);
    font-size: 13px;
    color: var(--text-muted);
    background: none;
    border: none;
    cursor: pointer;
    width: 100%;
    font-family: var(--font);
    transition: all var(--duration) var(--ease);
  }
  .sidebar-signout:hover {
    background: var(--bg-raised);
    color: var(--red);
  }

  /* Main area */
  .chat-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--bg-base);
  }

  /* Header */
  .chat-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }
  .sidebar-toggle {
    padding: 6px 8px;
  }
  .chat-header-title {
    font-size: 14px;
    font-weight: 600;
  }
  .chat-header-actions {
    margin-left: auto;
  }
  .streaming-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--accent);
    font-weight: 500;
  }
  .streaming-dots {
    display: flex;
    gap: 3px;
    align-items: center;
  }
  .streaming-dot {
    width: 5px;
    height: 5px;
    background: var(--accent);
    border-radius: 50%;
    animation: streamDot 1.4s ease-in-out infinite;
  }
  .streaming-dot:nth-child(2) { animation-delay: 0.2s; }
  .streaming-dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes streamDot {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  /* Messages */
  .chat-messages {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  /* Empty state */
  .chat-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
    color: var(--text-muted);
    padding: 40px 20px;
  }
  .chat-empty-logo {
    position: relative;
    width: 80px;
    height: 80px;
    margin-bottom: 8px;
  }
  .chat-empty-logo-inner {
    width: 80px;
    height: 80px;
    border-radius: 22px;
    object-fit: contain;
    position: relative;
    z-index: 1;
  }
  .chat-empty-glow {
    position: absolute;
    inset: -12px;
    border-radius: 30px;
    background: radial-gradient(circle, rgba(99, 102, 241, 0.2) 0%, transparent 70%);
    animation: breathe 3s ease-in-out infinite;
    z-index: 0;
  }
  .chat-empty-title {
    font-size: 24px;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.5px;
    background: linear-gradient(135deg, var(--text-primary), var(--accent));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .chat-empty-subtitle {
    font-size: 14px;
    max-width: 360px;
    text-align: center;
    line-height: 1.5;
    margin-bottom: 8px;
  }
  .chat-quick-starts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
    max-width: 480px;
    margin-top: 8px;
  }
  .chat-quick-btn {
    padding: 8px 14px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-size: 13px;
    font-family: var(--font);
    cursor: pointer;
    transition: all var(--duration) var(--ease);
  }
  .chat-quick-btn:hover {
    border-color: var(--border-accent);
    color: var(--accent);
    background: var(--accent-subtle);
  }

  /* Error */
  .chat-error {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px;
    margin: 8px 20px;
    background: var(--red-subtle);
    border: 1px solid rgba(244, 63, 94, 0.2);
    border-radius: var(--radius);
    color: var(--red);
    font-size: 13px;
  }
  .chat-error-icon {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--red);
  }

  /* Input area */
  .chat-input-area {
    padding: 16px 20px 20px;
    background: var(--bg-base);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .chat-input-wrapper {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    max-width: 800px;
    margin: 0 auto;
    background: rgba(19, 19, 28, 0.8);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 8px 8px 8px 16px;
    transition: border-color var(--duration) var(--ease), box-shadow var(--duration) var(--ease);
  }
  .chat-input-wrapper:focus-within {
    border-color: var(--border-accent);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.08), 0 4px 20px rgba(0, 0, 0, 0.3);
  }
  .chat-input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-family: var(--font);
    font-size: 14px;
    line-height: 1.5;
    resize: none;
    outline: none;
    max-height: 200px;
    padding: 4px 0;
  }
  .chat-input::placeholder {
    color: var(--text-muted);
  }
  .chat-input:disabled {
    opacity: 0.5;
  }
  .chat-send-btn {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    border: none;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all var(--duration) var(--ease);
    box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
  }
  .chat-send-btn:hover:not(:disabled) {
    background: var(--accent-hover);
    box-shadow: 0 4px 16px rgba(99, 102, 241, 0.4);
    transform: scale(1.05);
  }
  .chat-send-btn:active:not(:disabled) {
    transform: scale(0.95);
  }
  .chat-send-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
    box-shadow: none;
  }

  /* Desktop: keep current flex behavior; hide when not open */
  .sidebar:not(.open) {
    display: none;
  }

  /* Mobile sidebar backdrop (hidden on desktop) */
  .sidebar-backdrop {
    display: none;
  }

  @media (max-width: 768px) {
    .sidebar {
      display: flex;
      position: fixed;
      top: 0;
      left: 0;
      height: 100vh;
      z-index: 100;
      transform: translateX(-100%);
      transition: transform 400ms cubic-bezier(0.4, 0, 0.2, 1);
    }
    .sidebar.open {
      transform: translateX(0);
    }
    .sidebar:not(.open) {
      display: flex;
    }
    .sidebar-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 99;
      background: rgba(0,0,0,0.5);
      border: none;
      cursor: pointer;
    }
  }
</style>
