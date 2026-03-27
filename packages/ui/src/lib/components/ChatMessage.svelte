<script lang="ts">
  import ToolCall from './ToolCall.svelte';
  import type { ChatMessage as ChatMessageType, ToolCall as ToolCallType, MediaAttachment } from '$lib/stores/chat.svelte';
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

  /** Create a small SVG icon from a path string. */
  function makeSvg(d: string): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
      svg.setAttribute(k, v);
    }
    // Split compound paths (space-separated segments starting with M)
    for (const seg of d.split(/(?=M)/)) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', seg.trim());
      svg.appendChild(path);
    }
    return svg;
  }

  /** Open a full-screen lightbox overlay for an image. */
  function openLightbox(src: string, alt: string) {
    // Remove existing lightbox if any
    document.querySelector('.img-lightbox')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'img-lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', alt || 'Image preview');

    const img = document.createElement('img');
    img.src = src;
    img.alt = alt || '';

    const toolbar = document.createElement('div');
    toolbar.className = 'img-lightbox-toolbar';

    // Download
    const dl = document.createElement('a');
    dl.className = 'img-lightbox-btn';
    dl.href = src;
    dl.download = alt || 'image';
    dl.title = 'Download';
    dl.appendChild(makeSvg('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'));
    toolbar.appendChild(dl);

    // Close
    const close = document.createElement('button');
    close.className = 'img-lightbox-btn';
    close.title = 'Close';
    close.appendChild(makeSvg('M18 6L6 18M6 6l12 12'));
    close.addEventListener('click', () => overlay.remove());
    toolbar.appendChild(close);

    overlay.appendChild(toolbar);
    overlay.appendChild(img);

    // Click backdrop to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // Esc to close
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
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

      // Wrap images with thumbnail + action buttons
      const imgs = messageBodyRef!.querySelectorAll('img');
      imgs.forEach(img => {
        if (img.parentElement?.classList.contains('img-wrap') || img.classList.contains('media-image')) return;
        const wrap = document.createElement('div');
        wrap.className = 'img-wrap';
        img.parentElement?.insertBefore(wrap, img);
        wrap.appendChild(img);

        const actions = document.createElement('div');
        actions.className = 'img-actions';

        // Expand button
        const expand = document.createElement('button');
        expand.className = 'img-action-btn';
        expand.title = 'View full size';
        expand.appendChild(makeSvg('M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7'));
        expand.addEventListener('click', (e) => {
          e.stopPropagation();
          openLightbox(img.src, img.alt);
        });
        actions.appendChild(expand);

        // Download button
        const dl = document.createElement('a');
        dl.className = 'img-action-btn';
        dl.setAttribute('href', img.src);
        dl.setAttribute('download', img.alt || 'image');
        dl.title = 'Download';
        dl.appendChild(makeSvg('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'));
        dl.addEventListener('click', (e) => e.stopPropagation());
        actions.appendChild(dl);

        wrap.appendChild(actions);

        // Click thumbnail to expand
        img.style.cursor = 'pointer';
        img.addEventListener('click', () => openLightbox(img.src, img.alt));
      });

      // Wire lightbox on media-image elements (not wrapped by img-wrap)
      const mediaImgs = messageBodyRef!.querySelectorAll('img.media-image');
      mediaImgs.forEach(img => {
        if ((img as HTMLElement).dataset.lbBound) return;
        (img as HTMLElement).dataset.lbBound = '1';
        img.addEventListener('click', () => openLightbox((img as HTMLImageElement).src, (img as HTMLImageElement).alt));
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
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
      </div>
    {:else}
      <div class="avatar assistant-avatar" class:error-avatar={isError}>
        {#if isError}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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

    {#if message.media && message.media.length > 0}
      <div class="media-attachments">
        {#each message.media as attachment}
          {#if attachment.type === 'image'}
            <img
              src="/api/v1/media/{encodeURIComponent(attachment.fileName)}"
              alt={attachment.caption || attachment.fileName}
              class="media-image"
              loading="lazy"
            />
          {:else}
            <a href="/api/v1/media/{encodeURIComponent(attachment.fileName)}" target="_blank" rel="noopener" class="media-file-link">
              {attachment.fileName}
            </a>
          {/if}
        {/each}
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
    background: var(--bg-wash);
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

  /* ── Media attachments from tool results ── */
  .media-attachments {
    margin: 8px 0;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .media-image {
    max-width: 320px;
    max-height: 240px;
    border-radius: 10px;
    object-fit: contain;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    cursor: pointer;
    transition: box-shadow 0.2s ease;
  }
  .media-image:hover {
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  }
  .media-file-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: var(--radius);
    background: var(--bg-raised);
    color: var(--accent);
    font-size: 13px;
    text-decoration: none;
    transition: background 0.15s;
  }
  .media-file-link:hover {
    background: var(--bg-elevated);
  }

  /* ── Generated images: thumbnail ── */
  :global(.img-wrap) {
    position: relative;
    display: inline-block;
    margin: 8px 0;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    transition: box-shadow 0.2s ease;
  }
  :global(.img-wrap:hover) {
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  }
  :global(.img-wrap img) {
    display: block;
    max-width: 280px;
    max-height: 200px;
    border-radius: 10px;
    object-fit: cover;
  }
  /* Action buttons container */
  :global(.img-actions) {
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  :global(.img-wrap:hover .img-actions) {
    opacity: 1;
  }
  :global(.img-action-btn) {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
    cursor: pointer;
    backdrop-filter: blur(4px);
    transition: background 0.15s ease;
  }
  :global(.img-action-btn:hover) {
    background: rgba(0, 0, 0, 0.85);
  }

  /* ── Lightbox overlay ── */
  :global(.img-lightbox) {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(8px);
    animation: lightboxIn 0.2s ease-out;
  }
  @keyframes lightboxIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  :global(.img-lightbox img) {
    max-width: 90vw;
    max-height: 85vh;
    border-radius: 8px;
    object-fit: contain;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
  }
  :global(.img-lightbox-toolbar) {
    position: absolute;
    top: 16px;
    right: 16px;
    display: flex;
    gap: 8px;
  }
  :global(.img-lightbox-btn) {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  :global(.img-lightbox-btn:hover) {
    background: rgba(255, 255, 255, 0.25);
  }

  @media (hover: none) {
    .message-actions {
      opacity: 1;
    }
    :global(.img-actions) {
      opacity: 1;
    }
  }
</style>
