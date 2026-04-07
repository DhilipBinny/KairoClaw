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

import type { SkillRegistry } from '../skills/registry.js';

/** Context needed by slash command handlers. */
export interface SlashCommandContext {
  db: DatabaseAdapter;
  config: GatewayConfig;
  session: SessionRow;
  tenantId: string;
  userId?: string;
  callLLM?: CallLLMFn;
  skillRegistry?: SkillRegistry;
}

/** Result of a slash command. */
export interface SlashCommandResult {
  text: string;
  /** If true, this is a skill invocation — the text should be sent to the LLM as context, not returned directly. */
  isSkill?: boolean;
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
    await messageRepo.deleteBySession(session.id);
    return {
      text: `Session reset. New session: \`${session.id.slice(0, 8)}\``,
    };
  }

  if (action === 'status') {
    const messages = await messageRepo.listBySession(session.id);
    const tokenEst = estimateMessageTokens(messages);
    const modelName = config.model?.primary || 'default';
    const compaction = await needsCompaction(session.id, modelName, db, config);
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
        context.tenantId,
      );
      if (result.compacted) {
        const methodLabel = result.method === 'soft-clean' ? 'Soft clean' : 'Compacted';
        return {
          text: `${methodLabel}: ${result.oldMessageCount} -> ${result.newMessageCount} messages (${result.method}), saved ~${(result.tokensSaved ?? 0).toLocaleString()} tokens`,
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
      const metadata = JSON.parse(session.metadata || '{}');
      const sessionOverride = metadata.model_override || null;
      return {
        text: `Current model: \`${sessionOverride || config.model.primary}\`${sessionOverride ? ' (session override)' : ''}\nUsage: \`/model provider/model-name\``,
      };
    }
    // Validate against known models from fallback chain + primary
    const knownModels = [config.model.primary, ...(config.model.fallbackChain || [])];
    if (!knownModels.includes(newModel)) {
      return {
        text: `Unknown model: \`${newModel}\`\nAvailable: ${knownModels.map(m => `\`${m}\``).join(', ')}`,
      };
    }
    // Store per-session override in metadata instead of mutating global config
    const meta = JSON.parse(session.metadata || '{}');
    meta.model_override = newModel;
    await sessionRepo.update(session.id, { metadata: JSON.stringify(meta) });
    return {
      text: `Model switched for this session: \`${newModel}\``,
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
        `- \`/help\` — Show this help\n` +
        (context.skillRegistry && context.skillRegistry.size > 0
          ? `\n**Skills** (invoke with \`/skill-name\`):\n` +
            context.skillRegistry.list().map(s => `- \`/${s.name}\` — ${s.description}`).join('\n')
          : ''),
    };
  }

  if (action === 'sessions') {
    const sessions = await sessionRepo.listByTenant(context.tenantId);
    const lines = sessions.map((s) => {
      const totalTokens = (s.input_tokens || 0) + (s.output_tokens || 0);
      return `- \`${s.channel}:${s.chat_id ?? 'main'}\` — ${s.turns || 0} turns, ${totalTokens} tokens`;
    });
    return {
      text: `**Active Sessions** (${sessions.length})\n${lines.join('\n') || 'None'}`,
    };
  }

  // ── Skill invocation: /skill-name args ──
  // If no built-in command matched, check if it's a skill name
  if (context.skillRegistry) {
    const skillName = command.replace(/^\//, '');
    const skill = context.skillRegistry.get(skillName);
    if (skill) {
      // Return skill instructions to be injected into the conversation.
      // The agent loop will prepend these to the user's message and send
      // to the LLM for processing (not return raw to the user).
      return {
        text: `[Skill: ${skill.meta.name}]\n\nFollow these instructions for this task:\n\n${skill.instructions}${text ? `\n\n---\n**User request:** ${text}` : ''}`,
        isSkill: true,
      };
    }
  }

  return null;
}
