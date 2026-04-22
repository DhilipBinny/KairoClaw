<script lang="ts">
  interface Props {
    value: string[];
    placeholder?: string;
    onchange: (newValue: string[]) => void;
    id?: string;
  }
  let { value, placeholder = '', onchange, id }: Props = $props();
  let inputText = $state('');

  function addChip() {
    const trimmed = inputText.trim();
    if (trimmed && !value.includes(trimmed)) {
      onchange([...value, trimmed]);
      inputText = '';
    }
  }

  function removeChip(index: number) {
    onchange(value.filter((_, i) => i !== index));
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addChip();
    }
    if (e.key === 'Backspace' && !inputText && value.length > 0) {
      removeChip(value.length - 1);
    }
  }
</script>

<div class="chip-input-container">
  {#each value as chip, i}
    <span class="chip">
      <span class="chip-text">{chip}</span>
      <button
        type="button"
        class="chip-remove"
        onclick={() => removeChip(i)}
        aria-label="Remove {chip}"
      >&times;</button>
    </span>
  {/each}
  <input
    {id}
    type="text"
    class="chip-text-input"
    bind:value={inputText}
    onkeydown={handleKeydown}
    onblur={addChip}
    {placeholder}
  />
</div>

<style>
  .chip-input-container {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-height: 38px;
    padding: 6px 10px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-void);
    transition: border-color var(--duration) var(--ease), box-shadow var(--duration) var(--ease);
    cursor: text;
  }
  .chip-input-container:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    background: var(--accent-subtle);
    color: var(--accent);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.4;
    white-space: nowrap;
    animation: fadeIn 0.15s var(--ease);
  }
  .chip-text {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--accent);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.7;
    transition: opacity var(--duration) var(--ease), background var(--duration) var(--ease);
  }
  .chip-remove:hover {
    opacity: 1;
    background: var(--accent-wash);
  }
  .chip-text-input {
    flex: 1 1 80px;
    min-width: 80px;
    padding: 2px 0;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-family: var(--font);
    font-size: 16px;
    outline: none;
  }
  .chip-text-input::placeholder {
    color: var(--text-muted);
  }
  @media (min-width: 769px) { .chip-text-input { font-size: 14px; } }
</style>
