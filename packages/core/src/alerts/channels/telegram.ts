import type { AlertEvent, AlertInstance, AlertDeliveryChannel } from '@agw/types';
import { createModuleLogger } from '../../observability/logger.js';

const log = createModuleLogger('alert');
const TELEGRAM_ALERT_RETRIES = 2;
const TELEGRAM_ALERT_RETRY_DELAY_MS = 3000;

type TelegramSendFn = (chatId: string, text: string) => Promise<void>;

export class TelegramAlertChannel implements AlertDeliveryChannel {
  readonly name = 'telegram';
  private sendFn: TelegramSendFn | null = null;
  private chatIds: string[] = [];

  setSender(fn: TelegramSendFn | null): void {
    this.sendFn = fn;
  }

  setChatIds(ids: string[]): void {
    this.chatIds = ids;
  }

  async send(event: AlertEvent, instance: AlertInstance, kind: 'firing' | 'resolved'): Promise<void> {
    if (!this.sendFn || this.chatIds.length === 0) return;

    const icon = kind === 'resolved' ? '✅' : event.severity === 'critical' ? '🔴' : '🟡';
    const status = kind === 'resolved' ? 'RESOLVED' : 'ALERT';
    const body = kind === 'resolved' ? event.message : instance.message;
    const text = `${icon} ${status}: ${event.title}\n${body}`;

    for (const chatId of this.chatIds) {
      let sent = false;
      for (let attempt = 0; attempt < TELEGRAM_ALERT_RETRIES && !sent; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, TELEGRAM_ALERT_RETRY_DELAY_MS));
          await this.sendFn(chatId, text);
          sent = true;
        } catch (e) {
          log.warn({ chatId, attempt, err: e instanceof Error ? e.message : String(e) }, 'Telegram alert delivery attempt failed');
        }
      }
      if (!sent) {
        log.error({ chatId }, 'Telegram alert delivery exhausted retries');
      }
    }
  }
}
