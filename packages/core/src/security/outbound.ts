/**
 * Outbound message validation.
 *
 * Enforces outbound policies: the bot can only send messages to
 * contacts that have an existing session or are in the outbound allowlist.
 */

import type { GatewayConfig } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('security');

export interface OutboundCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether the bot is allowed to send an outbound message to a recipient.
 *
 * Policy:
 * - 'unrestricted': always allowed
 * - 'session-only' (default): allowed if the recipient has an active session OR
 *   is in the channel's outboundAllowlist
 */
export function checkOutboundAllowed(
  channel: 'whatsapp' | 'telegram',
  recipient: string,
  config: GatewayConfig,
  db: DatabaseAdapter,
): OutboundCheckResult {
  const channelConfig = config.channels?.[channel];
  if (!channelConfig) {
    return { allowed: true }; // channel not configured, skip validation
  }

  const policy = (channelConfig as any).outboundPolicy as string || 'session-only';

  if (policy === 'unrestricted') {
    return { allowed: true };
  }

  // Check outbound allowlist
  const allowlist: string[] = (channelConfig as any).outboundAllowlist || [];
  if (allowlist.length > 0) {
    // For WhatsApp: match full JID or just the phone part
    const recipientPhone = recipient.replace(/@.*$/, '');
    const matched = allowlist.some(entry => {
      const entryPhone = entry.replace(/@.*$/, '');
      return entry === recipient || entryPhone === recipientPhone;
    });
    if (matched) {
      return { allowed: true };
    }
  }

  // Check sessions table — does this recipient have an existing session?
  // Sessions are stored as chat_id = "whatsapp:JID" or "telegram:chatId"
  const chatIdPattern = `${channel}:${recipient}`;
  const session = db.get<{ id: string }>(
    'SELECT id FROM sessions WHERE channel = ? AND chat_id = ? LIMIT 1',
    [channel, chatIdPattern],
  );
  if (session) {
    return { allowed: true };
  }

  // Also try matching without the channel prefix (in case of format mismatch)
  const sessionAlt = db.get<{ id: string }>(
    'SELECT id FROM sessions WHERE chat_id LIKE ? LIMIT 1',
    [`%${recipient}%`],
  );
  if (sessionAlt) {
    return { allowed: true };
  }

  log.warn({ channel, recipient, policy }, 'Outbound message blocked by policy');
  return {
    allowed: false,
    reason: `No active session found for "${recipient}" on ${channel}. The recipient must message the bot first, or be added to the outbound allowlist.`,
  };
}
