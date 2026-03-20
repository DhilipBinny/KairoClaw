<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    id?: string;
    hint?: string;
    error?: string;
    children: Snippet;
  }

  let { label, id, hint, error, children }: Props = $props();
</script>

<div class="form-field">
  <label class="field-label" for={id}>{label}</label>
  {#if hint}<span class="field-hint">{hint}</span>{/if}
  {@render children()}
  {#if error}<span class="field-error" role="alert">{error}</span>{/if}
</div>

<style>
  .form-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .field-hint {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .field-error {
    font-size: 11px;
    color: var(--red);
    line-height: 1.4;
  }
</style>
