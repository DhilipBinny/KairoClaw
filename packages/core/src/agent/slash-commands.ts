/**
 * Slash command handler.
 *
 * Parses and executes commands like /reset, /status, /help, /model,
 * /sessions, /compact, /cron. Returns null if the text is not a
 * recognised slash command.
 */

import type { GatewayConfig } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import type { SessionRow } from '../db/repositories/session.js';
import { SessionRepository } from '../db/repositories/session.js';
import { MessageRepository } from '../db/repositories/message.js';
import {
  estimateMessageTokens,
  needsCompaction,
  checkAndCompact,
  type CallLLMFn,
} from './compaction.js';

/** Context needed by slash command handlers. */
export interface SlashCommandContext {
  db: DatabaseAdapter;
  config: GatewayConfig;
  session: SessionRow;
  tenantId: string;
  userId?: string;
  callLLM?: CallLLMFn;
}

/** Result of a slash command. */
export interface SlashCommandResult {
  text: string;
}

const SLASH_COMMANDS: Record<string, string> = {
  '/new': 'reset',
  '/reset': 'reset',
  '/status': 'status',
  '/stop': 'stop',
  '/compact': 'compact',
  '/model': 'model',
  '/help': 'help',
  '/sessions': 'sessions',
};

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
  const action = SLASH_COMMANDS[command.toLowerCase()];
  if (!action) return null;

  const { db, config, session } = context;
  const sessionRepo = new SessionRepository(db);
  const messageRepo = new MessageRepository(db);

  if (action === 'reset') {
    // Delete messages for the session — the caller creates a new session
    messageRepo.deleteBySession(session.id);
    return {
      text: `Session reset. New session: \`${session.id.slice(0, 8)}\``,
    };
  }

  if (action === 'status') {
    const messages = messageRepo.listBySession(session.id);
    const tokenEst = estimateMessageTokens(messages);
    const modelName = config.model?.primary || 'default';
    const compaction = needsCompaction(session.id, modelName, db, config);
    return {
      text:
        `**Session Status**\n` +
        `- Key: ${session.channel}:${session.chat_id ?? 'main'}\n` +
        `- Session: ${session.id.slice(0, 8)}\n` +
        `- Turns: ${session.turns}\n` +
        `- Messages: ${messages.length}\n` +
        `- Tokens (est): ${tokenEst.toLocaleString()}\n` +
        `- Tokens: ${(session.input_tokens || 0).toLocaleString()} in / ${(session.output_tokens || 0).toLocaleString()} out\n` +
        `- Model: ${modelName}\n` +
        `- Compaction: ${compaction.needed ? 'needed' : 'ok'}\n` +
        `- Updated: ${session.updated_at}`,
    };
  }

  if (action === 'stop') {
    return { text: 'Stopped.' };
  }

  if (action === 'compact') {
    try {
      const result = await checkAndCompact(
        session.id,
        config.model.primary,
        db,
        config,
        context.callLLM,
      );
      if (result.compacted) {
        return {
          text: `Compacted: ${result.oldMessageCount} -> ${result.newMessageCount} messages, saved ~${(result.tokensSaved ?? 0).toLocaleString()} tokens`,
        };
      }
      return {
        text: `No compaction needed (${(result.tokens ?? 0).toLocaleString()} tokens, threshold: ${(result.threshold ?? 0).toLocaleString()})`,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { text: `Compaction error: ${msg}` };
    }
  }

  if (action === 'model') {
    const newModel = text.trim();
    if (!newModel) {
      return {
        text: `Current model: \`${config.model.primary}\`\nUsage: \`/model provider/model-name\``,
      };
    }
    const oldModel = config.model.primary;
    config.model.primary = newModel;
    return {
      text: `Model switched: \`${oldModel}\` -> \`${newModel}\``,
    };
  }

  if (action === 'help') {
    return {
      text:
        `**Available Commands**\n` +
        `- \`/new\` — Reset session\n` +
        `- \`/status\` — Show session status\n` +
        `- \`/model [provider/model]\` — Switch model\n` +
        `- \`/compact\` — Force context compaction\n` +
        `- \`/sessions\` — List active sessions\n` +
        `- \`/stop\` — Stop current generation\n` +
        `- \`/help\` — Show this help`,
    };
  }

  if (action === 'sessions') {
    const sessions = sessionRepo.listByTenant(context.tenantId);
    const lines = sessions.map((s) => {
      const totalTokens = (s.input_tokens || 0) + (s.output_tokens || 0);
      return `- \`${s.channel}:${s.chat_id ?? 'main'}\` — ${s.turns || 0} turns, ${totalTokens} tokens`;
    });
    return {
      text: `**Active Sessions** (${sessions.length})\n${lines.join('\n') || 'None'}`,
    };
  }

  return null;
}
