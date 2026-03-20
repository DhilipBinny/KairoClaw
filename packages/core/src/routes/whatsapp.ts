/**
 * WhatsApp admin routes.
 *
 * Pairing, status, and unpair endpoints for the WhatsApp channel.
 */

import QRCode from 'qrcode';
import type { FastifyPluginAsync } from 'fastify';
import type { WhatsAppChannelInstance } from '../channels/whatsapp.js';
import { requireRole } from '../auth/middleware.js';

export interface WhatsAppRoutesOptions {
  channelRegistry: { whatsapp?: WhatsAppChannelInstance };
}

export const registerWhatsAppRoutes: FastifyPluginAsync<WhatsAppRoutesOptions> = async (app, opts) => {
  const { channelRegistry } = opts;

  // GET /api/v1/admin/whatsapp/status — connection status + phone number
  app.get('/api/v1/admin/whatsapp/status', { preHandler: [requireRole('admin')] }, async () => {
    const wa = channelRegistry.whatsapp;
    if (!wa) {
      return { status: 'disabled', phone: null, name: null };
    }
    return {
      status: wa.getConnectionStatus(),
      phone: wa.getConnectedPhone(),
      name: wa.getConnectedName(),
    };
  });

  // GET /api/v1/admin/whatsapp/qr — QR code as data URL image (for pairing)
  app.get('/api/v1/admin/whatsapp/qr', { preHandler: [requireRole('admin')] }, async () => {
    const wa = channelRegistry.whatsapp;
    if (!wa) {
      return { qr: null, qrDataUrl: null, status: 'disabled' };
    }
    const qr = wa.getQRCode();
    let qrDataUrl: string | null = null;
    if (qr) {
      try {
        qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      } catch {
        // Fallback: return raw QR string
      }
    }
    return {
      qr,
      qrDataUrl,
      status: wa.getConnectionStatus(),
    };
  });

  // POST /api/v1/admin/whatsapp/unpair — disconnect and clear credentials
  app.post('/api/v1/admin/whatsapp/unpair', { preHandler: [requireRole('admin')] }, async () => {
    const wa = channelRegistry.whatsapp;
    if (!wa) {
      return { success: false, error: 'WhatsApp channel not enabled' };
    }
    await wa.unpair();
    return { success: true };
  });
};
