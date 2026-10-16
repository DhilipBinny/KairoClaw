import { createHmac } from 'node:crypto';
import type { AlertEvent, AlertInstance, AlertDeliveryChannel } from '@agw/types';
import { createModuleLogger } from '../../observability/logger.js';
import { ALERT_WEBHOOK_TIMEOUT_MS, ALERT_WEBHOOK_MAX_RETRIES } from '../../constants.js';

const log = createModuleLogger('alert');

export class WebhookAlertChannel implements AlertDeliveryChannel {
  readonly name = 'webhook';
  private urls: string[] = [];
  private secret = '';

  setConfig(urls: string[], secret: string): void {
    this.urls = urls;
    this.secret = secret;
    if (urls.length > 0 && !secret) {
      log.warn('Webhook alert delivery enabled without HMAC secret — signatures disabled');
    }
  }

  async send(event: AlertEvent, instance: AlertInstance, kind: 'firing' | 'resolved'): Promise<void> {
    if (this.urls.length === 0) return;

    const sentAt = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      kind,
      type: event.type,
      severity: event.severity,
      title: event.title,
      message: kind === 'resolved' ? event.message : instance.message,
      fingerprint: event.fingerprint,
      labels: event.labels,
      firedAt: instance.firedAt ? new Date(instance.firedAt).toISOString() : null,
      resolvedAt: instance.resolvedAt ? new Date(instance.resolvedAt).toISOString() : null,
      timestamp: new Date(event.timestamp).toISOString(),
    });

    const signature = this.secret
      ? createHmac('sha256', this.secret).update(`${sentAt}.${payload}`).digest('hex')
      : '';

    for (const url of this.urls) {
      await this.sendToUrl(url, payload, signature, sentAt);
    }
  }

  private async sendToUrl(url: string, payload: string, signature: string, sentAt: number): Promise<void> {
    const backoffs = [0, 1000, 5000];
    for (let attempt = 0; attempt < ALERT_WEBHOOK_MAX_RETRIES; attempt++) {
      if (backoffs[attempt]) await new Promise(r => setTimeout(r, backoffs[attempt]));
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (signature) {
          headers['X-Webhook-Signature'] = `sha256=${signature}`;
          headers['X-Webhook-Timestamp'] = String(sentAt);
        }

        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: payload,
          signal: AbortSignal.timeout(ALERT_WEBHOOK_TIMEOUT_MS),
        });

        if (resp.ok) return;
        log.warn({ url, status: resp.status, attempt }, 'Webhook delivery non-2xx');
      } catch (e) {
        log.warn({ url, attempt, err: e instanceof Error ? e.message : String(e) }, 'Webhook delivery failed');
      }
    }
    log.error({ url }, 'Webhook delivery exhausted retries');
  }
}
