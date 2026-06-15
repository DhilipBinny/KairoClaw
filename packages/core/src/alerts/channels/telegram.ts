import type { AlertEvent, AlertInstance, AlertDeliveryChannel } from '@agw/types';
import { createModuleLogger } from '../../observability/logger.js';

const log = createModuleLogger('alert');

type TelegramSendFn = (chatId: string, text: string) => Promise<void>;

export class TelegramAlertChannel implements AlertDeliveryChannel {
  readonly name = 'telegram';
  private sendFn: TelegramSendFn | null = null;
  private chatIds: string[] = [];

  setSender(fn: TelegramSendFn): void {
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
      try {
        await this.sendFn(chatId, text);
      } catch (e) {
        log.error({ chatId, err: e instanceof Error ? e.message : String(e) }, 'Telegram alert delivery failed');
      }
    }
  }
}
