import type { GatewayConfig } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { extractSessionMemory, createInitialState } from './session-memory.js';
import { maybeExtractToProfile } from './auto-memory.js';
import { createModuleLogger } from '../observability/logger.js';
import { estimateMessageTokens } from '@agw/memory-engine';
import { MessageRepository } from '../db/repositories/message.js';

const log = createModuleLogger('memory');

const MIN_TURNS_FOR_PROFILE_INTERACTIVE = 2;
const MIN_TURNS_FOR_PROFILE_CRON = 1;

/**
 * Trigger memory extraction for a session that just expired.
 *
 * Runs async (fire-and-forget) so the user's new session isn't blocked.
 * Extracts session memory (structured notes) and then attempts profile
 * extraction (daily notes → PROFILE.md). This is the session-end flush
 * that bridges knowledge between sessions.
 */
export function triggerSessionEndExtraction(opts: {
  sessionId: string;
  channel: string;
  scopeKey: string;
  db: DatabaseAdapter;
  config: GatewayConfig;
  providerRegistry: ProviderRegistry;
}): void {
  const { sessionId, channel, scopeKey, db, config, providerRegistry } = opts;

  const callLLM = (args: Parameters<ProviderRegistry['callWithFailover']>[0]) =>
    providerRegistry.callWithFailover(args);

  const run = async () => {
    const messageRepo = new MessageRepository(db);
    const messages = await messageRepo.listBySession(sessionId);
    if (messages.length === 0) return;

    const currentTokens = estimateMessageTokens(messages);

    // Step 1: Extract session memory (structured notes file)
    try {
      await extractSessionMemory({
        sessionId,
        scopeKey,
        db,
        config,
        state: createInitialState(),
        currentTokens,
        callLLM,
      });
      log.info({ sessionId, channel }, 'Session-end extraction: session memory written');
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log.warn({ sessionId, err }, 'Session-end extraction: session memory failed');
    }

    // Step 2: Extract to daily notes + PROFILE.md
    // Note: we pass minTurns=2 (lower than the default 5) and do NOT
    // skip cron/internal channels — cron sessions deserve memory too.
    try {
      const isCron = channel === 'cron' || channel === 'internal';
      await maybeExtractToProfile({
        sessionId,
        channel,
        scopeKey,
        db,
        config,
        callLLM,
        minTurns: isCron ? MIN_TURNS_FOR_PROFILE_CRON : MIN_TURNS_FOR_PROFILE_INTERACTIVE,
        skipChannelCheck: true,
      });
      log.info({ sessionId, channel }, 'Session-end extraction: profile extraction complete');
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log.warn({ sessionId, err }, 'Session-end extraction: profile extraction failed');
    }
  };

  run().catch((e) => {
    const err = e instanceof Error ? e.message : String(e);
    log.error({ sessionId, err }, 'Session-end extraction: unexpected failure');
  });
}
