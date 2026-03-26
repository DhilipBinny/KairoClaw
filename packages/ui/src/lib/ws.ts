/**
 * WebSocket client for real-time chat and events.
 * Handles auth, reconnection, and message dispatching.
 */

type MessageHandler = (msg: Record<string, unknown>) => void;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
const handlers = new Map<string, Set<MessageHandler>>();
let isConnected = false;
let connectPromiseResolve: (() => void) | null = null;
let authFailed = false; // Stop reconnect loop when auth is rejected

function getToken(): string | null {
  return localStorage.getItem('agw_api_key');
}

function getWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export function on(type: string, handler: MessageHandler): () => void {
  if (!handlers.has(type)) {
    handlers.set(type, new Set());
  }
  handlers.get(type)!.add(handler);
  return () => {
    handlers.get(type)?.delete(handler);
  };
}

function dispatch(msg: Record<string, unknown>): void {
  const type = msg.type as string;
  if (!type) return;

  // Dispatch to specific type handlers
  handlers.get(type)?.forEach((h) => {
    try { h(msg); } catch (e) { console.error('WS handler error:', e); }
  });

  // Dispatch to wildcard handlers
  handlers.get('*')?.forEach((h) => {
    try { h(msg); } catch (e) { console.error('WS wildcard handler error:', e); }
  });
}

export function connect(): Promise<void> {
  authFailed = false; // Reset on explicit connect (e.g., after fresh login)
  return new Promise((resolve) => {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      if (isConnected) {
        resolve();
      } else {
        connectPromiseResolve = resolve;
      }
      return;
    }

    connectPromiseResolve = resolve;
    const url = getWsUrl();
    socket = new WebSocket(url);

    socket.onopen = () => {
      reconnectDelay = 1000;
      authFailed = false;
      // Send auth
      const token = getToken();
      if (token) {
        socket?.send(JSON.stringify({ type: 'auth', token }));
      }
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as Record<string, unknown>;
        if (msg.type === 'auth.ok') {
          isConnected = true;
          connectPromiseResolve?.();
          connectPromiseResolve = null;
          // Request chat history for the current session after auth succeeds
          const sessionKey = localStorage.getItem('agw_session_key') || 'main';
          socket?.send(JSON.stringify({ type: 'chat.history', sessionKey, limit: 50 }));
        } else if (msg.type === 'auth.error') {
          // Auth rejected — don't reconnect, this won't fix itself
          authFailed = true;
          connectPromiseResolve = null;
        }
        dispatch(msg);
      } catch {
        console.error('WS message parse error');
      }
    };

    socket.onclose = () => {
      isConnected = false;
      socket = null;
      dispatch({ type: 'connection.lost' });
      if (!authFailed) scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose will fire after this
    };
  });
}

function scheduleReconnect(): void {
  if (!getToken()) return; // Don't reconnect if not logged in

  // Clear any existing timer to prevent accumulation
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect().catch(() => {});
  }, reconnectDelay);
}

export function send(msg: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  } else {
    console.warn('WebSocket not connected, queuing reconnect');
    connect().then(() => {
      socket?.send(JSON.stringify(msg));
    });
  }
}

export function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  isConnected = false;
  if (socket) {
    socket.close();
    socket = null;
  }
}

export function getConnectionState(): boolean {
  return isConnected;
}
