/**
 * Channels admin routes.
 *
 * Unified status endpoint for all messaging channels (Telegram, WhatsApp).
 * Telegram test endpoint, pending senders management.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { TelegramChannelInstance } from '../channels/telegram.js';
import type { WhatsAppChannelInstance } from '../channels/whatsapp.js';
import type { GatewayConfig } from '@agw/types';
import type { SecretsStore } from '../secrets/store.js';
import type { DatabaseAdapter } from '../db/index.js';
import { PendingSenderRepository } from '../db/repositories/pending-sender.js';
import { SenderLinkRepository } from '../db/repositories/sender-link.js';
import { UserRepository } from '../db/repositories/user.js';
import { requireRole } from '../auth/middleware.js';
import { generateApiKey, hashApiKey } from '../auth/keys.js';
import { setNestedPath } from './utils.js';

export interface ChannelRoutesOptions {
  channelRegistry: {
    telegram?: TelegramChannelInstance;
    whatsapp?: WhatsAppChannelInstance;
  };
  config: GatewayConfig;
  secretsStore?: SecretsStore;
}

export const registerChannelRoutes: FastifyPluginAsync<ChannelRoutesOptions> = async (app, opts) => {
  const { channelRegistry, config, secretsStore } = opts;

  // GET /api/v1/admin/channels/status — aggregated status of all channels
  app.get('/api/v1/admin/channels/status', { preHandler: [requireRole('admin')] }, async () => {
    // Telegram status
    const tgToken = secretsStore?.get('channels.telegram', 'botToken') || config.channels?.telegram?.botToken || '';
    const tgHasToken = !!(tgToken && !tgToken.startsWith('${'));
    const tgEnabled = !!(config.channels?.telegram?.enabled && tgHasToken);
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
        hasToken: tgHasToken,
        tokenHint: tgHasToken ? tgToken.slice(0, 4) + '...' : null,
      },
      whatsapp: {
        enabled: waEnabled,
        status: waStatus,
        phone: waPhone,
        name: waName,
      },
    };
  });

  // ── P1-1: Telegram test endpoint ────────────────────────
  app.post('/api/v1/admin/channels/telegram/test', { preHandler: [requireRole('admin')] }, async (request) => {
    const { token: inputToken } = (request.body as { token?: string }) || {};
    const botToken = inputToken || secretsStore?.get('channels.telegram', 'botToken') || config.channels?.telegram?.botToken;
    if (!botToken || botToken.startsWith('${')) {
      return { success: false, error: 'No bot token configured' };
    }

    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json() as { ok?: boolean; result?: { username?: string }; description?: string };
      if (data.ok && data.result) {
        return { success: true, username: data.result.username };
      }
      return { success: false, error: data.description || 'Invalid bot token' };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message };
    }
  });

  // ── P3-3: Pending senders endpoints ─────────────────────

  // GET /api/v1/admin/channels/pending-senders
  app.get('/api/v1/admin/channels/pending-senders', { preHandler: [requireRole('admin')] }, async (request) => {
    const db = (request as unknown as { ctx: { db: DatabaseAdapter } }).ctx.db;
    try {
      const repo = new PendingSenderRepository(db);
      const pending = await repo.listByStatus('pending', 50);
      const seen = await repo.listByStatus('seen', 50);
      return {
        senders: [...pending, ...seen],
        counts: {
          pending: await repo.countAllByStatus('pending'),
          seen: await repo.countAllByStatus('seen'),
        },
      };
    } catch {
      return { senders: [], counts: { pending: 0, seen: 0 } };
    }
  });

  // POST /api/v1/admin/channels/pending-senders/:id/approve
  app.post('/api/v1/admin/channels/pending-senders/:id/approve', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const db = (request as unknown as { ctx: { db: DatabaseAdapter; config: GatewayConfig } }).ctx.db;
    const liveConfig = (request as unknown as { ctx: { config: GatewayConfig } }).ctx.config;
    const { id } = request.params as { id: string };

    const repo = new PendingSenderRepository(db);
    const sender = await repo.getById(Number(id));
    if (!sender) {
      return reply.code(404).send({ error: 'Sender not found' });
    }

    // Add to allowFrom (individuals) or groupAllowFrom (groups)
    const stateDir = liveConfig._stateDir || '';
    const configPath = path.join(stateDir, 'config.json');

    // Detect if this is a group or individual by sender_id pattern
    const isGroup = (sender.channel === 'telegram' && sender.sender_id.startsWith('-'))
      || (sender.channel === 'whatsapp' && sender.sender_id.endsWith('@g.us'));

    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const rawConfig = JSON.parse(raw) as Record<string, unknown>;

      let dotPath: string;
      if (sender.channel === 'telegram') {
        dotPath = isGroup ? 'channels.telegram.groupAllowFrom' : 'channels.telegram.allowFrom';
      } else if (sender.channel === 'whatsapp') {
        dotPath = isGroup ? 'channels.whatsapp.groupAllowFrom' : 'channels.whatsapp.allowFrom';
      } else {
        return reply.code(400).send({ error: `Unknown channel: ${sender.channel}` });
      }

      // Get existing allowFrom list
      const parts = dotPath.split('.');
      let current: unknown = rawConfig;
      for (const part of parts) {
        if (current && typeof current === 'object') current = (current as Record<string, unknown>)[part];
        else { current = undefined; break; }
      }
      const existingList = Array.isArray(current) ? [...current] : [];
      if (!existingList.includes(sender.sender_id)) {
        existingList.push(sender.sender_id);
      }

      // Update raw config and live config
      setNestedPath(rawConfig, dotPath, existingList);
      setNestedPath(liveConfig as unknown as Record<string, unknown>, dotPath, existingList);
      fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), { mode: 0o600 });
    } catch {
      return reply.code(500).send({ error: 'Failed to update config' });
    }

    await repo.updateStatus(Number(id), 'approved');

    // If userId provided, create sender_link (maps this sender to a user account)
    const { userId: linkUserId } = (request.body as { userId?: string }) || {};
    if (linkUserId && !isGroup) {
      const tenantId = request.tenantId || 'default';
      const senderLinkRepo = new SenderLinkRepository(db);
      await senderLinkRepo.link({
        tenantId,
        channelType: sender.channel,
        senderId: sender.sender_id,
        userId: linkUserId,
        linkedBy: request.user?.id,
      });
    }

    return { success: true };
  });

  // POST /api/v1/admin/channels/pending-senders/:id/reject
  app.post('/api/v1/admin/channels/pending-senders/:id/reject', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const db = (request as unknown as { ctx: { db: DatabaseAdapter } }).ctx.db;
    const { id } = request.params as { id: string };

    const repo = new PendingSenderRepository(db);
    const sender = await repo.getById(Number(id));
    if (!sender) {
      return reply.code(404).send({ error: 'Sender not found' });
    }

    await repo.updateStatus(Number(id), 'rejected');
    return { success: true };
  });

  // POST /api/v1/admin/channels/pending-senders/:id/onboard — one-click: create user + approve + link
  app.post('/api/v1/admin/channels/pending-senders/:id/onboard', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const db = (request as unknown as { ctx: { db: DatabaseAdapter; config: GatewayConfig } }).ctx.db;
    const liveConfig = (request as unknown as { ctx: { config: GatewayConfig } }).ctx.config;
    const { id } = request.params as { id: string };
    const { name, email, role, elevated } = (request.body as {
      name: string; email?: string; role?: string; elevated?: boolean;
    }) || {};

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({ error: 'Name is required' });
    }

    const pendingRepo = new PendingSenderRepository(db);
    const sender = await pendingRepo.getById(Number(id));
    if (!sender) {
      return reply.code(404).send({ error: 'Sender not found' });
    }

    const tenantId = request.tenantId || 'default';
    const validRoles = ['admin', 'user'];
    const userRole = role && validRoles.includes(role) ? role : 'user';

    // 1. Create user account
    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);
    const userRepo = new UserRepository(db);
    const user = await userRepo.create({
      tenantId,
      name: name.trim(),
      email: email?.trim() || undefined,
      role: userRole,
      apiKeyHash,
    });
    if (elevated) {
      await userRepo.update(user.id, { elevated: 1 });
    }

    // 2. Create sender_link
    const senderLinkRepo = new SenderLinkRepository(db);
    await senderLinkRepo.link({
      tenantId,
      channelType: sender.channel,
      senderId: sender.sender_id,
      userId: user.id,
      linkedBy: request.user?.id,
    });

    // 3. Add to allowFrom config (same logic as approve)
    const isGroup = (sender.channel === 'telegram' && sender.sender_id.startsWith('-'))
      || (sender.channel === 'whatsapp' && sender.sender_id.endsWith('@g.us'));
    const stateDir = liveConfig._stateDir || '';
    const configPath = path.join(stateDir, 'config.json');

    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const rawConfig = JSON.parse(raw) as Record<string, unknown>;
      let dotPath: string;
      if (sender.channel === 'telegram') {
        dotPath = isGroup ? 'channels.telegram.groupAllowFrom' : 'channels.telegram.allowFrom';
      } else if (sender.channel === 'whatsapp') {
        dotPath = isGroup ? 'channels.whatsapp.groupAllowFrom' : 'channels.whatsapp.allowFrom';
      } else {
        dotPath = `channels.${sender.channel}.allowFrom`;
      }

      const parts = dotPath.split('.');
      let current: unknown = rawConfig;
      for (const part of parts) {
        if (current && typeof current === 'object') current = (current as Record<string, unknown>)[part];
        else { current = undefined; break; }
      }
      const existingList = Array.isArray(current) ? [...current] : [];
      if (!existingList.includes(sender.sender_id)) {
        existingList.push(sender.sender_id);
      }
      setNestedPath(rawConfig, dotPath, existingList);
      setNestedPath(liveConfig as unknown as Record<string, unknown>, dotPath, existingList);
      fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), { mode: 0o600 });
    } catch {
      // Config update failed, but user + link created — not critical
    }

    // 4. Mark sender as approved (after DB operations succeed, before return)
    try { await pendingRepo.updateStatus(Number(id), 'approved'); } catch { /* non-critical */ }

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        elevated: !!elevated,
        active: true,
      },
      api_key: apiKey,
    };
  });
};
