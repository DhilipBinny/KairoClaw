<script lang="ts">
  import { getToasts, removeToast } from '$lib/stores/toast.svelte';

  let toasts = $derived(getToasts());
</script>

{#if toasts.length > 0}
  <div class="toast-container" aria-live="polite">
    {#each toasts as toast (toast.id)}
      <div class="toast toast-{toast.type}">
        <span class="toast-message">{toast.message}</span>
        <button
          type="button"
          class="toast-dismiss"
          onclick={() => removeToast(toast.id)}
          aria-label="Dismiss"
        >&times;</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 380px;
  }
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 16px;
    border-radius: var(--radius);
    font-size: 13px;
    line-height: 1.4;
    box-shadow: var(--shadow-md);
    animation: toastSlideIn 0.25s var(--ease);
  }
  .toast-success {
    background: var(--green-subtle);
    border: 1px solid rgba(52, 211, 153, 0.25);
    color: var(--green);
  }
  .toast-error {
    background: var(--red-subtle);
    border: 1px solid rgba(244, 63, 94, 0.25);
    color: var(--red);
  }
  .toast-info {
    background: var(--blue-subtle);
    border: 1px solid rgba(56, 189, 248, 0.25);
    color: var(--blue);
  }
  .toast-message {
    flex: 1;
  }
  .toast-dismiss {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity var(--duration) var(--ease);
  }
  .toast-dismiss:hover {
    opacity: 1;
  }
  @keyframes toastSlideIn {
    from {
      opacity: 0;
      transform: translateX(20px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }
</style>
