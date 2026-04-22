let updateAvailableCallback: (() => void) | null = null;

export function applyUpdate() {
  navigator.serviceWorker?.controller?.postMessage({ type: 'SKIP_WAITING' });
}

export function initPwa() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  // Listen for new service worker taking control → reload
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });

  // Detect waiting worker (update available)
  navigator.serviceWorker.ready.then((reg) => {
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          updateAvailableCallback?.();
        }
      });
    });
  });
}

export function onUpdateAvailable(cb: () => void) {
  updateAvailableCallback = cb;
}
