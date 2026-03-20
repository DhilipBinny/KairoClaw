/**
 * Channels admin routes.
 *
 * Unified status endpoint for all messaging channels (Telegram, WhatsApp).
 */

import type { FastifyPluginAsync } from 'fastify';
import type { TelegramChannelInstance } from '../channels/telegram.js';
import type { WhatsAppChannelInstance } from '../channels/whatsapp.js';
import type { GatewayConfig } from '@agw/types';
import { requireRole } from '../auth/middleware.js';

export interface ChannelRoutesOptions {
  channelRegistry: {
    telegram?: TelegramChannelInstance;
    whatsapp?: WhatsAppChannelInstance;
  };
  config: GatewayConfig;
}

export const registerChannelRoutes: FastifyPluginAsync<ChannelRoutesOptions> = async (app, opts) => {
  const { channelRegistry, config } = opts;

  // GET /api/v1/admin/channels/status — aggregated status of all channels
  app.get('/api/v1/admin/channels/status', { preHandler: [requireRole('admin')] }, async () => {
    // Telegram status
    const tgEnabled = !!(config.channels?.telegram?.enabled && config.channels.telegram.botToken);
    let tgConnected = false;
    let tgBotUsername: string | undefined;
    if (channelRegistry.telegram) {
      const botInfo = channelRegistry.telegram.getBotInfo();
      if (botInfo) {
        tgConnected = true;
        tgBotUsername = botInfo.username;
      }
    }

    // WhatsApp status
    const waEnabled = !!config.channels?.whatsapp?.enabled;
    let waStatus = 'disabled';
    let waPhone: string | null = null;
    let waName: string | null = null;
    if (channelRegistry.whatsapp) {
      waStatus = channelRegistry.whatsapp.getConnectionStatus();
      waPhone = channelRegistry.whatsapp.getConnectedPhone();
      waName = channelRegistry.whatsapp.getConnectedName();
    }

    return {
      telegram: {
        enabled: tgEnabled,
        connected: tgConnected,
        botUsername: tgBotUsername || null,
      },
      whatsapp: {
        enabled: waEnabled,
        status: waStatus,
        phone: waPhone,
        name: waName,
      },
    };
  });
};
