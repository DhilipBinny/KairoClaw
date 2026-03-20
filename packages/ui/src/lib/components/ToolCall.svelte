<script lang="ts">
  interface ToolCallData {
    name: string;
    status: 'running' | 'done' | 'error';
    args?: string[];
    preview?: string;
  }

  interface Props {
    tools: ToolCallData[];
  }

  let { tools }: Props = $props();
  let expanded = $state(false);
  // Track which individual items are expanded (for grouped tool calls)
  let expandedItems: Record<number, boolean> = $state({});

  /**
   * Parse a tool name like "mcp__github__list_issues" into
   * { displayName: "list_issues", server: "github" }
   */
  function parseToolName(raw: string): { displayName: string; server: string | null } {
    const mcpMatch = raw.match(/^mcp__([^_]+(?:__[^_]+)*)__(.+)$/);
    if (mcpMatch) {
      // Handle server names that may contain double underscores
      // Pattern: mcp__<server>__<tool>
      const parts = raw.replace(/^mcp__/, '').split('__');
      if (parts.length >= 2) {
        const toolName = parts[parts.length - 1];
        const server = parts.slice(0, -1).join('__');
        return { displayName: toolName, server };
      }
    }
    return { displayName: raw, server: null };
  }

  /** Get the overall status — running if any is running, error if any errored, else done */
  let groupStatus = $derived.by(() => {
    if (tools.some(t => t.status === 'running')) return 'running';
    if (tools.some(t => t.status === 'error')) return 'error';
    return 'done';
  });

  let count = $derived(tools.length);
  let parsed = $derived(parseToolName(tools[0].name));

  function toggleItem(idx: number) {
    expandedItems = { ...expandedItems, [idx]: !expandedItems[idx] };
  }

  function truncate(text: string, max: number = 500): string {
    if (!text || text.length <= max) return text || '';
    return text.slice(0, max) + '...';
  }
</script>

<div
  class="tool-call"
  class:running={groupStatus === 'running'}
  class:done={groupStatus === 'done'}
  class:errored={groupStatus === 'error'}
>
  <button class="tool-header" onclick={() => expanded = !expanded}>
    <span class="tool-status-icon">
      {#if groupStatus === 'running'}
        <span class="tc-spinner"></span>
      {:else if groupStatus === 'error'}
        <span class="tc-error-icon">&#10007;</span>
      {:else}
        <span class="tc-check-icon">&#10003;</span>
      {/if}
    </span>
    <span class="tool-display-name">{parsed.displayName}</span>
    {#if parsed.server}
      <span class="tool-server-badge">{parsed.server}</span>
    {/if}
    {#if count > 1}
      <span class="tool-count">&times;{count}</span>
    {/if}
    <span class="tool-expand-chevron" class:open={expanded}>&#9656;</span>
  </button>

  <div class="tool-body" class:open={expanded}>
    <div class="tool-body-inner">
      {#if count === 1}
        <!-- Single tool call: show args + preview directly -->
        {#if tools[0].args && tools[0].args.length > 0}
          <div class="tool-detail">
            <span class="tool-detail-label">Args:</span>
            <code class="tool-detail-value">{tools[0].args.join(', ')}</code>
          </div>
        {/if}
        {#if tools[0].preview}
          <div class="tool-detail">
            <span class="tool-detail-label">Result:</span>
            <pre class="tool-preview-text">{truncate(tools[0].preview)}</pre>
          </div>
        {/if}
      {:else}
        <!-- Grouped tool calls -->
        {#each tools as tool, idx}
          <div class="tool-group-item">
            <button class="tool-group-header" onclick={() => toggleItem(idx)}>
              <span class="tool-status-icon-sm">
                {#if tool.status === 'running'}
                  <span class="tc-spinner sm"></span>
                {:else if tool.status === 'error'}
                  <span class="tc-error-icon">&#10007;</span>
                {:else}
                  <span class="tc-check-icon">&#10003;</span>
                {/if}
              </span>
              <span class="tool-group-label">Call #{idx + 1}</span>
              {#if tool.args && tool.args.length > 0}
                <span class="tool-args-brief">{tool.args[0]}{tool.args.length > 1 ? ', ...' : ''}</span>
              {/if}
              <span class="tool-expand-chevron sm" class:open={expandedItems[idx]}>&#9656;</span>
            </button>
            <div class="tool-group-body" class:open={expandedItems[idx]}>
              <div class="tool-group-body-inner">
                {#if tool.args && tool.args.length > 0}
                  <div class="tool-detail">
                    <span class="tool-detail-label">Args:</span>
                    <code class="tool-detail-value">{tool.args.join(', ')}</code>
                  </div>
                {/if}
                {#if tool.preview}
                  <div class="tool-detail">
                    <span class="tool-detail-label">Result:</span>
                    <pre class="tool-preview-text">{truncate(tool.preview)}</pre>
                  </div>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .tool-call {
    margin: 4px 0;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-void);
    font-size: 12px;
    color: var(--text-secondary);
    overflow: hidden;
    border-left: 3px solid var(--border);
    transition: border-color var(--duration) var(--ease);
  }
  .tool-call.running { border-left-color: var(--yellow); }
  .tool-call.done { border-left-color: var(--tool); }
  .tool-call.errored { border-left-color: var(--red); }

  .tool-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 12px;
    border: none;
    background: none;
    cursor: pointer;
    font-family: var(--font);
    font-size: 12px;
    color: var(--text-secondary);
    text-align: left;
    transition: background var(--duration) var(--ease);
  }
  .tool-header:hover {
    background: var(--bg-raised);
  }

  .tool-status-icon {
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .tool-status-icon-sm {
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .tc-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--yellow);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    display: inline-block;
  }
  .tc-spinner.sm {
    width: 10px;
    height: 10px;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .tc-check-icon { color: var(--tool); font-size: 13px; }
  .tc-error-icon { color: var(--red); font-size: 13px; font-weight: bold; }

  .tool-display-name {
    font-family: var(--font-mono);
    font-weight: 500;
    color: var(--tool);
    font-size: 12px;
  }

  .tool-server-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--tool-subtle);
    color: var(--tool);
    font-weight: 500;
    letter-spacing: 0.2px;
  }

  .tool-count {
    font-size: 11px;
    color: var(--text-muted);
    font-weight: 600;
  }

  .tool-expand-chevron {
    margin-left: auto;
    font-size: 10px;
    color: var(--text-muted);
    transition: transform 0.2s var(--ease);
    flex-shrink: 0;
  }
  .tool-expand-chevron.open {
    transform: rotate(90deg);
  }
  .tool-expand-chevron.sm {
    font-size: 9px;
  }

  /* CSS grid collapse/expand */
  .tool-body {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.25s var(--ease);
  }
  .tool-body.open {
    grid-template-rows: 1fr;
  }
  .tool-body-inner {
    overflow: hidden;
    padding: 0 12px;
  }
  .tool-body.open .tool-body-inner {
    padding: 4px 12px 8px;
  }

  .tool-group-item {
    border-top: 1px solid var(--border-subtle);
  }
  .tool-group-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 4px;
    border: none;
    background: none;
    cursor: pointer;
    font-family: var(--font);
    font-size: 11px;
    color: var(--text-secondary);
    text-align: left;
    transition: background var(--duration) var(--ease);
  }
  .tool-group-header:hover {
    background: var(--bg-raised);
    border-radius: 4px;
  }
  .tool-group-label {
    font-weight: 500;
    color: var(--text-primary);
    font-size: 11px;
  }
  .tool-args-brief {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }

  .tool-group-body {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.2s var(--ease);
  }
  .tool-group-body.open {
    grid-template-rows: 1fr;
  }
  .tool-group-body-inner {
    overflow: hidden;
    padding: 0 4px;
  }
  .tool-group-body.open .tool-group-body-inner {
    padding: 4px 4px 6px;
  }

  .tool-detail {
    margin-bottom: 4px;
  }
  .tool-detail-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.3px;
    display: block;
    margin-bottom: 2px;
  }
  .tool-detail-value {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-secondary);
    background: var(--bg-surface);
    padding: 2px 6px;
    border-radius: 3px;
    word-break: break-all;
  }
  .tool-preview-text {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-secondary);
    background: var(--bg-surface);
    border-radius: 4px;
    padding: 6px 8px;
    margin: 2px 0 0;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--border-subtle);
  }
</style>
