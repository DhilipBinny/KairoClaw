/**
 * Re-export shim — delegates to @agw/agent-core.
 *
 * Wraps handleSlashCommand to accept `db: DatabaseAdapter` and internally
 * construct the MessageStore and SessionLister interfaces.
 */

export type { SlashCommandResult } from '@agw/agent-core';

import type { GatewayConfig, DatabaseAdapter } from '@agw/types';
import type { SessionRow } from '../db/repositories/session.js';
import { SessionRepository } from '../db/repositories/session.js';
import { MessageRepository } from '../db/repositories/message.js';
import {
  handleSlashCommand as _handleSlashCommand,
  type SlashCommandResult,
  type CallLLMFn,
  type MessageStore,
  type SessionLister,
} from '@agw/agent-core';

export type { CallLLMFn } from '@agw/agent-core';

/** Context needed by slash command handlers (backward-compatible). */
export interface SlashCommandContext {
  db: DatabaseAdapter;
  config: GatewayConfig;
  session: SessionRow;
  tenantId: string;
  userId?: string;
  callLLM?: CallLLMFn;
}

/** Adapt a MessageRepository to the MessageStore interface. */
function repoToMessageStore(db: DatabaseAdapter): MessageStore {
  const repo = new MessageRepository(db);
  return {
    listBySession: (sessionId, limit) => repo.listBySession(sessionId, limit),
    listSinceId: (sessionId, sinceId) => repo.listSinceId(sessionId, sinceId),
    create: (msg) => repo.create(msg),
    deleteBySession: (sessionId) => repo.deleteBySession(sessionId),
    updateContent: (id, content) => repo.updateContent(id, content),
  };
}

/** Adapt a SessionRepository to the SessionLister interface. */
function repoToSessionLister(db: DatabaseAdapter): SessionLister {
  const repo = new SessionRepository(db);
  return {
    listByTenant: (tenantId, limit) => repo.listByTenant(tenantId, limit),
    update: (id, data) => repo.update(id, data),
  };
}

/**
 * Parse and execute a slash command.
 *
 * @returns The command result, or `null` if the text is not a slash command.
 */
export async function handleSlashCommand(
  command: string,
  text: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult | null> {
  const { db, config, session, tenantId, userId, callLLM } = context;
  return _handleSlashCommand(command, text, {
    messageStore: repoToMessageStore(db),
    sessionStore: repoToSessionLister(db),
    config,
    session,
    tenantId,
    userId,
    callLLM,
  });
}
