<script lang="ts">
  import { fetchMediaBlobUrl } from '$lib/api';
  import { onDestroy } from 'svelte';

  interface Props {
    fileName: string;
    alt?: string;
    className?: string;
  }

  let { fileName, alt = '', className = '' }: Props = $props();

  let blobUrl: string | null = $state(null);
  let error: boolean = $state(false);
  let loading: boolean = $state(true);

  $effect(() => {
    let cancelled = false;
    blobUrl = null;
    error = false;
    loading = true;

    fetchMediaBlobUrl(fileName)
      .then((url) => {
        if (!cancelled) {
          blobUrl = url;
          loading = false;
        } else {
          URL.revokeObjectURL(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          error = true;
          loading = false;
        }
      });

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  });

  onDestroy(() => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  });

  function makeSvgIcon(pathD: string): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
      svg.setAttribute(k, v);
    }
    for (const seg of pathD.split(/(?=M)/)) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', seg.trim());
      svg.appendChild(p);
    }
    return svg;
  }

  function openLightbox() {
    if (!blobUrl) return;
    document.querySelector('.img-lightbox')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'img-lightbox';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const img = document.createElement('img');
    img.src = blobUrl;
    img.alt = alt;

    const toolbar = document.createElement('div');
    toolbar.className = 'img-lightbox-toolbar';

    const dl = document.createElement('a');
    dl.className = 'img-lightbox-btn';
    dl.href = blobUrl;
    dl.download = alt || fileName;
    dl.appendChild(makeSvgIcon('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5l5-5M12 15V3'));
    toolbar.appendChild(dl);

    const close = document.createElement('button');
    close.className = 'img-lightbox-btn';
    close.appendChild(makeSvgIcon('M18 6L6 18M6 6l12 12'));
    close.addEventListener('click', () => overlay.remove());
    toolbar.appendChild(close);

    overlay.appendChild(img);
    overlay.appendChild(toolbar);
    document.body.appendChild(overlay);
  }
</script>

{#if loading}
  <div class="auth-image-loading {className}">
    <span class="auth-image-spinner"></span>
  </div>
{:else if error}
  <div class="auth-image-error {className}">Failed to load image</div>
{:else if blobUrl}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <img
    src={blobUrl}
    {alt}
    class={className}
    onclick={openLightbox}
    onkeydown={(e) => { if (e.key === 'Enter') openLightbox(); }}
    style="cursor: pointer;"
  />
{/if}

<style>
  .auth-image-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 120px;
    min-height: 80px;
    border-radius: 10px;
    background: var(--bg-raised);
  }
  .auth-image-spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .auth-image-error {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 120px;
    min-height: 80px;
    border-radius: 10px;
    background: var(--bg-raised);
    color: var(--text-muted);
    font-size: 12px;
  }
</style>
