import type { AlertEvent, AlertInstance, AlertDeliveryChannel } from '@agw/types';
import { broadcastToAdmins } from '../../channels/webchat.js';

export class WebSocketAlertChannel implements AlertDeliveryChannel {
  readonly name = 'websocket';

  async send(event: AlertEvent, instance: AlertInstance, kind: 'firing' | 'resolved'): Promise<void> {
    broadcastToAdmins({
      type: 'alert',
      alert: {
        kind,
        alertType: event.type,
        severity: event.severity,
        title: event.title,
        message: kind === 'resolved' ? event.message : instance.message,
        fingerprint: event.fingerprint,
        labels: event.labels,
        firedAt: instance.firedAt,
        resolvedAt: instance.resolvedAt,
        timestamp: event.timestamp,
      },
    });
  }
}
