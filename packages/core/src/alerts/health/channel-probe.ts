import type { AlertManager } from '../index.js';
import { ALERT_TYPES } from '@agw/types';
import { createModuleLogger } from '../../observability/logger.js';
import { ALERT_HEALTH_PROBE_INTERVAL_MS } from '../../constants.js';

const log = createModuleLogger('alert');

interface ChannelRegistry {
  telegram?: { bot: unknown; getConnectionStatus?: () => string };
  whatsapp?: { getConnectionStatus?: () => string; connectionStatus?: string };
}

export class ChannelHealthProbe {
  private timer: ReturnType<typeof setInterval> | null = null;
  private alertManager: AlertManager;
  private channelRegistry: ChannelRegistry;

  constructor(alertManager: AlertManager, channelRegistry: ChannelRegistry) {
    this.alertManager = alertManager;
    this.channelRegistry = channelRegistry;
  }

  start(): void {
    this.timer = setInterval(() => this.check(), ALERT_HEALTH_PROBE_INTERVAL_MS);
    log.info({ intervalMs: ALERT_HEALTH_PROBE_INTERVAL_MS }, 'Channel health probe started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private check(): void {
    this.checkWhatsApp();
    this.checkTelegram();
  }

  private checkWhatsApp(): void {
    const wa = this.channelRegistry.whatsapp;
    if (!wa) return;

    const status = typeof wa.getConnectionStatus === 'function'
      ? wa.getConnectionStatus()
      : wa.connectionStatus ?? 'unknown';

    const labels = { source: 'whatsapp', channel: 'whatsapp' };

    if (status === 'connected') {
      this.alertManager.emitSuccess(ALERT_TYPES.CHANNEL_DISCONNECTED, labels);
    } else {
      this.alertManager.emitFailure({
        type: ALERT_TYPES.CHANNEL_DISCONNECTED,
        severity: 'critical',
        source: 'whatsapp',
        labels,
        title: 'WhatsApp disconnected',
        message: `WhatsApp connection status: ${status}`,
      });
    }
  }

  private checkTelegram(): void {
    const tg = this.channelRegistry.telegram;
    if (!tg) return;

    const labels = { source: 'telegram', channel: 'telegram' };
    const hasBot = !!tg.bot;

    if (hasBot) {
      this.alertManager.emitSuccess(ALERT_TYPES.CHANNEL_DISCONNECTED, labels);
    } else {
      this.alertManager.emitFailure({
        type: ALERT_TYPES.CHANNEL_DISCONNECTED,
        severity: 'critical',
        source: 'telegram',
        labels,
        title: 'Telegram bot unavailable',
        message: 'Telegram bot instance is not running',
      });
    }
  }
}
