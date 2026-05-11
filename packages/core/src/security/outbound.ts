import type { GatewayConfig } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import { checkOutboundAllowed as _checkOutboundAllowed } from '@agw/security';
import { createModuleLogger } from '../observability/logger.js';

export type { OutboundCheckResult } from '@agw/security';

const log = createModuleLogger('security');

export async function checkOutboundAllowed(
  channel: 'whatsapp' | 'telegram',
  recipient: string,
  config: GatewayConfig,
  db: DatabaseAdapter,
) {
  return _checkOutboundAllowed(channel, recipient, config, db, log);
}
