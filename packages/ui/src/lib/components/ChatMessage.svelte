<script lang="ts">
  import ToolCall from './ToolCall.svelte';
  import type { ChatMessage as ChatMessageType, ToolCall as ToolCallType } from '$lib/stores/chat.svelte';

  interface Props {
    message: ChatMessageType;
    onRetry?: (message: ChatMessageType) => void;
    onDelete?: (message: ChatMessageType) => void;
  }

  let { message, onRetry, onDelete }: Props = $props();

  let isError = $derived(
    message.role === 'assistant' &&
    (message.content.startsWith('LLM error:') || message.content.startsWith('\u26A0\uFE0F'))
  );

  /**
   * Group consecutive tool calls with the same name.
   * Returns an array of arrays — each inner array has tools with the same name.
   */
  function groupToolCalls(tools: ToolCallType[]): ToolCallType[][] {
    if (!tools || tools.length === 0) return [];
    const groups: ToolCallType[][] = [];
    let current: ToolCallType[] = [tools[0]];
    for (let i = 1; i < tools.length; i++) {
      if (tools[i].name === current[0].name) {
        current.push(tools[i]);
      } else {
        groups.push(current);
        current = [tools[i]];
      }
    }
    groups.push(current);
    return groups;
  }

  let toolGroups = $derived(groupToolCalls(message.toolCalls || []));

  /**
   * Simple markdown-to-HTML renderer.
   */
  function renderMarkdown(text: string): string {
    if (!text) return '';

    let html = text;

    // Escape HTML
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold and italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Horizontal rules
    html = html.replace(/^---$/gm, '<hr>');

    // Unordered lists
    html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Paragraphs
    html = html.replace(/^(?!<[hupblo]|<li|<hr|<blockquote|<pre)(.+)$/gm, '<p>$1</p>');
    html = html.replace(/<p><\/p>/g, '');

    return html;
  }
</script>

<div
  class="message"
  class:user={message.role === 'user'}
  class:assistant={message.role === 'assistant'}
  class:error={isError}
>
  <div class="message-avatar">
    {#if message.role === 'user'}
      <div class="avatar user-avatar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
      </div>
    {:else}
      <div class="avatar assistant-avatar" class:error-avatar={isError}>
        {#if isError}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
        {:else}
          A
        {/if}
      </div>
    {/if}
  </div>

  <div class="message-body">
    {#if message.role === 'user'}
      <div class="message-text">{message.content}</div>
    {:else if isError}
      <div class="message-text error-text">{message.content}</div>
    {:else}
      <div class="message-text markdown-content" class:streaming-cursor={message.isStreaming && message.content}>
        {#if message.isStreaming && !message.content}
          <span class="cursor-blink"></span>
        {:else}
          {@html renderMarkdown(message.content)}
        {/if}
      </div>
    {/if}

    {#if toolGroups.length > 0}
      <div class="tool-calls-section">
        {#each toolGroups as group}
          <ToolCall tools={group} />
        {/each}
      </div>
    {/if}

    <!-- Action buttons: show on hover (or always for errors) -->
    <div class="message-actions" class:always-show={isError}>
      {#if message.role === 'user' && onRetry}
        <button class="action-btn" title="Retry this message" onclick={() => onRetry?.(message)}>
          Retry
        </button>
      {/if}
      {#if isError && onRetry}
        <button class="action-btn retry-btn" title="Retry" onclick={() => onRetry?.(message)}>
          Retry
        </button>
      {/if}
      {#if onDelete}
        <button class="action-btn delete-btn" title="Delete this message" onclick={() => onDelete?.(message)}>
          Delete
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .message {
    display: flex;
    gap: 14px;
    padding: 18px 24px;
    animation: messageIn 0.3s ease-out;
    position: relative;
    transition: background var(--duration) var(--ease);
  }
  @keyframes messageIn {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .message.user {
    background: transparent;
  }
  .message.user:hover {
    background: rgba(255, 255, 255, 0.01);
  }
  .message.assistant {
    background: var(--bg-surface);
  }
  .message.assistant:hover {
    background: rgba(19, 19, 28, 0.9);
  }
  .message.error {
    background: rgba(244, 63, 94, 0.04);
    border-left: 3px solid var(--red);
  }
  .message-avatar {
    flex-shrink: 0;
    padding-top: 2px;
  }
  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 600;
  }
  .user-avatar {
    background: var(--bg-raised);
    color: var(--text-secondary);
  }
  .assistant-avatar {
    background: linear-gradient(135deg, var(--accent), #a78bfa);
    color: #fff;
    box-shadow: 0 2px 8px rgba(99, 102, 241, 0.25);
  }
  .error-avatar {
    background: var(--red) !important;
    box-shadow: 0 2px 8px rgba(244, 63, 94, 0.3) !important;
  }
  .message-body {
    flex: 1;
    min-width: 0;
    padding-top: 2px;
  }
  .message-text {
    line-height: 1.65;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  .error-text {
    color: var(--red);
    font-size: 13px;
    font-family: var(--font-mono);
  }

  /* Tool calls section - visually separated */
  .tool-calls-section {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--border-subtle);
  }

  /* Action buttons */
  .message-actions {
    display: flex;
    gap: 4px;
    margin-top: 8px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  .message:hover .message-actions,
  .message-actions.always-show {
    opacity: 1;
  }
  .action-btn {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 12px;
    padding: 3px 10px;
    cursor: pointer;
    font-family: var(--font);
    transition: all 0.15s ease;
  }
  .action-btn:hover {
    background: var(--bg-overlay);
    color: var(--text-primary);
  }
  .retry-btn {
    background: var(--accent-subtle);
    border-color: var(--border-accent);
    color: var(--accent);
  }
  .retry-btn:hover {
    background: var(--accent-wash);
  }
  .delete-btn:hover {
    background: var(--red-subtle);
    border-color: rgba(244, 63, 94, 0.2);
    color: var(--red);
  }
</style>
