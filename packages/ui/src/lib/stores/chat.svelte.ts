/**
 * Chat store — manages messages and streaming state.
 * Integrates with the WebSocket for real-time updates.
 */

import * as ws from '$lib/ws';

export interface ToolCall {
  name: string;
  status: 'running' | 'done';
  args?: string[];
  preview?: string;
}

export interface ChatMessage {
  id: string;
  dbId?: number;       // Database message ID for delete API
  sessionId?: string;  // Session ID for delete API
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
}

// Persist session key across page refreshes
function getSavedSessionKey(): string {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem('agw_session_key') || 'main';
  }
  return 'main';
}

// Module-level reactive state
let _messages: ChatMessage[] = $state([]);
let _isStreaming: boolean = $state(false);
let _currentSessionKey: string = $state(getSavedSessionKey());
let _error: string | null = $state(null);
let _thinkingLabel: string | null = $state(null);
let _currentSessionId: string | null = $state(null);
let _msgCounter = 0;

export function getMessages(): ChatMessage[] { return _messages; }
export function getIsStreaming(): boolean { return _isStreaming; }
export function getCurrentSessionKey(): string { return _currentSessionKey; }
export function getError(): string | null { return _error; }
export function getThinkingLabel(): string | null { return _thinkingLabel; }

export function setSessionKey(key: string): void {
  _currentSessionKey = key;
  _messages = [];
  _error = null;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('agw_session_key', key);
  }
}

export function clearError(): void {
  _error = null;
}

let _unsubscribers: Array<() => void> = [];

export function initChatListeners(): void {
  // Clean up any existing listeners
  _unsubscribers.forEach((u) => u());
  _unsubscribers = [];

  _unsubscribers.push(
    ws.on('chat.ack', (_msg) => {
      _isStreaming = true;
      _error = null;
      _thinkingLabel = 'Thinking...';
    })
  );

  _unsubscribers.push(
    ws.on('chat.delta', (msg) => {
      _thinkingLabel = null;
      const text = msg.text as string;
      const lastMsg = _messages[_messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
        // Update in-place for reactivity
        _messages = _messages.map((m, i) =>
          i === _messages.length - 1
            ? { ...m, content: m.content + text }
            : m
        );
      } else {
        // Start a new assistant message
        _messages = [..._messages, {
          id: `msg-${++_msgCounter}`,
          role: 'assistant',
          content: text,
          timestamp: Date.now(),
          isStreaming: true,
          toolCalls: [],
        }];
      }
    })
  );

  _unsubscribers.push(
    ws.on('chat.tool', (msg) => {
      const name = msg.name as string;
      const status = msg.status as string;
      const lastMsg = _messages[_messages.length - 1];

      if (status === 'start') {
        // Extract a friendly name for the thinking label
        const parts = name.replace(/^mcp__/, '').split('__');
        const friendlyName = parts[parts.length - 1] || name;
        _thinkingLabel = `Using ${friendlyName}...`;
      }

      if (lastMsg && lastMsg.role === 'assistant') {
        const toolCalls = [...(lastMsg.toolCalls || [])];

        if (status === 'start') {
          toolCalls.push({
            name,
            status: 'running',
            args: msg.args as string[],
          });
        } else if (status === 'end') {
          const idx = toolCalls.findIndex((t) => t.name === name && t.status === 'running');
          if (idx >= 0) {
            toolCalls[idx] = { ...toolCalls[idx], status: 'done', preview: msg.preview as string };
          }
        }

        _messages = _messages.map((m, i) =>
          i === _messages.length - 1
            ? { ...m, toolCalls }
            : m
        );
      }
    })
  );

  _unsubscribers.push(
    ws.on('chat.done', (msg) => {
      _isStreaming = false;
      _thinkingLabel = null;
      const text = msg.text as string;
      const lastMsg = _messages[_messages.length - 1];

      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
        _messages = _messages.map((m, i) =>
          i === _messages.length - 1
            ? { ...m, content: text || m.content, isStreaming: false }
            : m
        );
      } else if (text) {
        _messages = [..._messages, {
          id: `msg-${++_msgCounter}`,
          role: 'assistant',
          content: text,
          timestamp: Date.now(),
          isStreaming: false,
        }];
      }
    })
  );

  _unsubscribers.push(
    ws.on('chat.error', (msg) => {
      _isStreaming = false;
      _thinkingLabel = null;
      _error = msg.message as string;
    })
  );

  _unsubscribers.push(
    ws.on('chat.history.result', (msg) => {
      const messages = msg.messages as Array<{ role: string; content: string }>;
      _messages = messages.map((m, i) => ({
        id: `msg-${++_msgCounter}`,
        role: m.role as 'user' | 'assistant',
        content: m.content || '',
        timestamp: Date.now() - (messages.length - i) * 1000,
      }));
    })
  );
}

export function destroyChatListeners(): void {
  _unsubscribers.forEach((u) => u());
  _unsubscribers = [];
}

export function sendMessage(text: string): void {
  // Add user message
  _messages = [..._messages, {
    id: `msg-${++_msgCounter}`,
    role: 'user',
    content: text,
    timestamp: Date.now(),
  }];

  // Send via WebSocket
  ws.send({
    type: 'chat.send',
    text,
    sessionKey: _currentSessionKey,
  });
}

/** Load history via REST API (called when switching sessions) */
export async function loadHistory(sessionId?: string): Promise<void> {
  if (sessionId) {
    _currentSessionId = sessionId;
    // Update session key to match the loaded session
    try {
      const { getSessions } = await import('$lib/stores/sessions.svelte');
      const session = getSessions().find((s) => s.id === sessionId);
      if (session) {
        _currentSessionKey = session.chatId ? session.chatId.replace(/^web:/, '') : `session-${sessionId}`;
      } else {
        _currentSessionKey = `session-${sessionId}`;
      }
    } catch {
      _currentSessionKey = `session-${sessionId}`;
    }
    // Load via REST API
    try {
      const { loadSessionMessages } = await import('$lib/stores/sessions.svelte');
      const messages = await loadSessionMessages(sessionId);
      _messages = messages.map((m, i) => ({
        id: `msg-${++_msgCounter}`,
        dbId: (m as any).id as number | undefined,
        sessionId,
        role: m.role as 'user' | 'assistant',
        content: m.content || '',
        timestamp: Date.now() - (messages.length - i) * 1000,
      }));
    } catch (e) {
      console.error('Failed to load history:', e);
    }
  } else {
    // Try via WebSocket as fallback
    ws.send({
      type: 'chat.history',
      sessionKey: _currentSessionKey,
      limit: 50,
    });
  }
}

export function clearMessages(): void {
  _messages = [];
}

/** Remove a message by ID (also removes subsequent messages to keep context clean) */
export async function removeMessage(id: string): Promise<void> {
  const idx = _messages.findIndex((m) => m.id === id);
  if (idx < 0) return;

  const msg = _messages[idx];

  // Delete from database if we have the DB ID
  if (msg.dbId && msg.sessionId) {
    try {
      const { deleteMessage } = await import('$lib/api');
      await deleteMessage(msg.sessionId, String(msg.dbId));
    } catch (e) {
      console.error('Failed to delete message from DB:', e);
    }
  }

  // Remove from UI (this message and everything after it)
  _messages = _messages.slice(0, idx);
}
