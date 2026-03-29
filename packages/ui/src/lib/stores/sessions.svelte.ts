/**
 * Sessions store — manages the session list via REST API (not WebSocket).
 */

import { getSessions as fetchSessions, getSession as fetchSession } from '$lib/api';

export interface SessionInfo {
  id: string;
  sessionKey: string;
  channel: string;
  chatId: string;
  title: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
}

let _sessions: SessionInfo[] = $state([]);
let _isLoading: boolean = $state(false);

export function getSessions(): SessionInfo[] { return _sessions; }
export function getIsLoading(): boolean { return _isLoading; }

/** Fetch sessions from REST API */
export async function loadSessions(): Promise<void> {
  _isLoading = true;
  try {
    const data = await fetchSessions(100);
    _sessions = (data.sessions || [])
      .filter((s) => s.turns > 0 && s.channel === 'web')
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .map((s) => {
        // Extract session key from chat_id (e.g., "web:main" → "main")
        const chatId = (s as any).chat_id || '';
        const chatKey = chatId.startsWith('web:') ? chatId.slice(4) : chatId || s.id;
        return {
          id: s.id,
          sessionKey: chatKey,
          channel: s.channel,
          chatId,
          title: (s as any).title || '',
          turns: s.turns,
          inputTokens: s.input_tokens,
          outputTokens: s.output_tokens,
          createdAt: s.created_at,
          updatedAt: s.updated_at,
        };
      });
  } catch (e) {
    console.error('Failed to load sessions:', e);
  } finally {
    _isLoading = false;
  }
}

/** Load messages for a specific session via REST API */
export async function loadSessionMessages(sessionId: string): Promise<Array<{ role: string; content: string; metadata?: string }>> {
  try {
    const data = await fetchSession(sessionId);
    return (data.messages || []).map((m) => ({
      id: (m as any).id,
      role: m.role,
      content: m.content,
      metadata: (m as any).metadata ?? undefined,
    }));
  } catch (e) {
    console.error('Failed to load session messages:', e);
    return [];
  }
}

// No more WebSocket listeners needed for sessions
export function initSessionListeners(): void {}
export function destroySessionListeners(): void {}
