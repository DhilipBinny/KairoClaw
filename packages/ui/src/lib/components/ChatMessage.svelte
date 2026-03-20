<script lang="ts">
  import ToolCall from './ToolCall.svelte';
  import type { ChatMessage as ChatMessageType, ToolCall as ToolCallType } from '$lib/stores/chat.svelte';
  import { marked } from 'marked';
  import hljs from 'highlight.js/lib/core';
  import javascript from 'highlight.js/lib/languages/javascript';
  import python from 'highlight.js/lib/languages/python';
  import typescript from 'highlight.js/lib/languages/typescript';
  import bash from 'highlight.js/lib/languages/bash';
  import json_lang from 'highlight.js/lib/languages/json';
  import css_lang from 'highlight.js/lib/languages/css';
  import xml from 'highlight.js/lib/languages/xml';
  import sql from 'highlight.js/lib/languages/sql';

  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('js', javascript);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('py', python);
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('ts', typescript);
  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('sh', bash);
  hljs.registerLanguage('shell', bash);
  hljs.registerLanguage('json', json_lang);
  hljs.registerLanguage('css', css_lang);
  hljs.registerLanguage('html', xml);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('sql', sql);

  const renderer = new marked.Renderer();
  renderer.code = function({ text, lang }: { text: string; lang?: string }) {
    let highlighted: string;
    if (lang && hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(text, { language: lang }).value;
    } else {
      highlighted = hljs.highlightAuto(text).value;
    }
    return `<pre><code class="hljs language-${lang || ''}">${highlighted}</code></pre>`;
  };

  marked.setOptions({ breaks: true, gfm: true, renderer });

  function renderMarkdown(text: string): string {
    if (!text) return '';
    return marked.parse(text) as string;
  }

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

  function relativeTime(ts: number): string {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(ts).toLocaleString();
  }

  let messageBodyRef: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (!messageBodyRef) return;
    // Re-run when content changes
    const _ = message.content;
    // Use tick to wait for DOM update
    setTimeout(() => {
      const pres = messageBodyRef!.querySelectorAll('pre');
      pres.forEach(pre => {
        if (pre.querySelector('.copy-code-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'copy-code-btn';
        btn.textContent = 'Copy';
        btn.addEventListener('click', () => {
          const code = pre.querySelector('code')?.textContent || pre.textContent || '';
          navigator.clipboard.writeText(code);
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
        });
        pre.style.position = 'relative';
        pre.appendChild(btn);
      });
    }, 0);
  });
</script>

<div
  class="message"
  class:user={message.role === 'user'}
  class:assistant={message.role === 'assistant'}
  class:error={isError}
  title={relativeTime(message.timestamp)}
>
  <div class="message-avatar">
    {#if message.role === 'user'}
      <div class="avatar user-avatar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
      </div>
    {:else}
      <div class="avatar assistant-avatar" class:error-avatar={isError}>
        {#if isError}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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

  <div class="message-body" bind:this={messageBodyRef}>
    {#if message.thinkingContent}
      <details class="thinking-section" open={message.isThinking}>
        <summary class="thinking-summary">
          {#if message.isThinking}
            <span class="thinking-indicator"></span> Thinking...
          {:else}
            Thought process
          {/if}
        </summary>
        <div class="thinking-content">{message.thinkingContent}</div>
      </details>
    {/if}

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
      {#if message.role === 'assistant' && !isError && message.content}
        <button class="action-btn" title="Copy message" onclick={() => navigator.clipboard.writeText(message.content)}>
          Copy
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
    background: var(--bg-wash);
  }
  .message.assistant {
    background: var(--bg-surface);
  }
  .message.assistant:hover {
    background: var(--bg-raised);
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

  /* Thinking section */
  .thinking-section {
    margin-bottom: 12px;
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    overflow: hidden;
  }
  .thinking-summary {
    padding: 8px 14px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(255, 255, 255, 0.02);
    transition: color var(--duration) var(--ease);
  }
  .thinking-summary:hover {
    color: var(--text-secondary);
  }
  .thinking-indicator {
    display: inline-block;
    width: 6px;
    height: 6px;
    background: var(--accent);
    border-radius: 50%;
    animation: thinkingPulse 1.5s ease-in-out infinite;
  }
  @keyframes thinkingPulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }
  .thinking-content {
    padding: 10px 14px;
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    line-height: 1.6;
    max-height: 300px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-wrap: break-word;
    border-top: 1px solid var(--border-subtle);
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
  :global(.copy-code-btn) {
    position: absolute;
    top: 8px;
    right: 8px;
    padding: 2px 8px;
    font-size: 11px;
    font-family: var(--font);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  :global(pre:hover .copy-code-btn) {
    opacity: 1;
  }

  @media (hover: none) {
    .message-actions {
      opacity: 1;
    }
  }
</style>
