/**
 * Interfaces for database interactions — decouples memory-engine from
 * concrete repository implementations in @agw/core.
 */

export interface MessageRow {
  id: number;
  session_id: string;
  tenant_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  metadata: string | null;
  created_at: string;
}

/**
 * Subset of MessageRepository needed by session-memory and auto-memory.
 * Consumers pass a concrete instance; this package only depends on the shape.
 */
export interface MessageLister {
  listBySession(sessionId: string, limit?: number): Promise<MessageRow[]>;
  listSinceId(sessionId: string, sinceId: number): Promise<MessageRow[]>;
}

/**
 * Subset of SessionRepository needed by session-memory state persistence.
 */
export interface SessionUpdater {
  getById(id: string): Promise<SessionRow | undefined>;
  update(id: string, data: Partial<{ metadata: string }>): Promise<void>;
}

export interface SessionRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  channel: string;
  chat_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  turns: number;
  metadata: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}
