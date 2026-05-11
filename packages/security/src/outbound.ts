import type { GatewayConfig, DatabaseAdapter, AgwLogger } from '@agw/types';
import { noopLogger } from '@agw/types';

export interface OutboundCheckResult {
  allowed: boolean;
  reason?: string;
}

export async function checkOutboundAllowed(
  channel: 'whatsapp' | 'telegram',
  recipient: string,
  config: GatewayConfig,
  db: DatabaseAdapter,
  logger: AgwLogger = noopLogger,
): Promise<OutboundCheckResult> {
  const channelConfig = config.channels?.[channel];
  if (!channelConfig) {
    return { allowed: false, reason: `Channel "${channel}" is not configured — defaulting to deny` };
  }

  const policy = (channelConfig as any).outboundPolicy as string || 'session-only';

  if (policy === 'unrestricted') {
    return { allowed: true };
  }

  const allowlist: string[] = (channelConfig as any).outboundAllowlist || [];
  if (allowlist.length > 0) {
    const recipientPhone = recipient.replace(/@.*$/, '');
    const matched = allowlist.some(entry => {
      const entryPhone = entry.replace(/@.*$/, '');
      return entry === recipient || entryPhone === recipientPhone;
    });
    if (matched) {
      return { allowed: true };
    }
  }

  const chatIdPattern = `${channel}:${recipient}`;
  const session = await db.get<{ id: string }>(
    'SELECT id FROM sessions WHERE channel = ? AND chat_id = ? LIMIT 1',
    [channel, chatIdPattern],
  );
  if (session) {
    return { allowed: true };
  }

  const escapedRecipient = recipient.replace(/[%_]/g, '\\$&');
  const sessionAlt = await db.get<{ id: string }>(
    "SELECT id FROM sessions WHERE chat_id LIKE ? ESCAPE '\\' LIMIT 1",
    [`%${escapedRecipient}%`],
  );
  if (sessionAlt) {
    return { allowed: true };
  }

  logger.warn({ channel, recipient, policy }, 'Outbound message blocked by policy');
  return {
    allowed: false,
    reason: `No active session found for "${recipient}" on ${channel}. The recipient must message the bot first, or be added to the outbound allowlist.`,
  };
}
