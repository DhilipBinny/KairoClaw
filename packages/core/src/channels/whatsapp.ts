/**
 * WhatsApp channel — Baileys (WhiskeySockets) integration.
 *
 * Implements the Channel interface for WhatsApp using QR-code pairing.
 * Handles text, image, document, voice/PTT messages. Supports allowlist
 * filtering, group mention detection, and per-session request queuing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PENDING_SEEN_CAP, PENDING_PENDING_CAP } from '../constants.js';
import { extractMedia } from '../media/detector.js';
import type { MediaItem } from '../media/detector.js';
import type { MediaAttachment } from '@agw/types';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
  isJidGroup,
  isJidStatusBroadcast,
  jidNormalizedUser,
  type WASocket,
  type WAMessage,
} from 'baileys';
import type { GatewayConfig, InboundMessage } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import type { Channel, AgentRunner } from './types.js';
import { AgentQueue } from '../queue/index.js';
import { splitMessage, markdownToWhatsApp } from './utils.js';
import { createModuleLogger } from '../observability/logger.js';
import { sanitizeInput, detectPromptInjection } from '../security/input.js';

const log = createModuleLogger('channel.whatsapp');

/** Shared silent logger for Baileys (suppresses all library log output). */
const silentLogger = {
  level: 'silent' as const,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger,
} as any;

// ─── Helpers ────────────────────────────────────────────────

/**
 * Extract the phone number part from a JID (e.g. "971501234567@s.whatsapp.net" → "971501234567").
 */
function phoneFromJid(jid: string): string {
  return jid.replace(/@.*$/, '');
}

// ─── WhatsAppChannel class ─────────────────────────────────

class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp';
  private sock: WASocket | null = null;
  private runner: AgentRunner | null = null;
  private readonly queue = new AgentQueue();
  private readonly config: GatewayConfig;
  private readonly db: DatabaseAdapter;
  private readonly tenantId: string;
  private currentQR: string | null = null;
  private connectionStatus: 'disconnected' | 'qr' | 'connected' = 'disconnected';
  private connectedPhone: string | null = null;
  private connectedName: string | null = null;
  private ownJid: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private authDir: string;
  /** LID → phone number mapping (WhatsApp's Linked Identity system). */
  private lidToPhone = new Map<string, string>();

  constructor(config: GatewayConfig, db: DatabaseAdapter, tenantId: string) {
    this.config = config;
    this.db = db;
    this.tenantId = tenantId;
    const stateDir = config._stateDir || path.join(process.env.HOME || '/tmp', '.agw');
    this.authDir = path.join(stateDir, 'whatsapp');
  }

  async start(runner: AgentRunner): Promise<void> {
    this.runner = runner;
    await this.connect();
  }

  private async connect(): Promise<void> {
    // Ensure auth directory exists
    fs.mkdirSync(this.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      // Pin version to work around Baileys 405 error (github.com/WhiskeySockets/Baileys/issues/2370)
      version: [2, 3000, 1033893291],
      browser: ['Kairo', 'Chrome', '145.0.0'],
      // Reduce log noise
      logger: silentLogger,
    });

    // Save credentials on update
    this.sock.ev.on('creds.update', saveCreds);

    // Handle connection events
    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      log.info({ connection, hasQR: !!qr, keys: Object.keys(update) }, 'WhatsApp connection.update');

      if (qr) {
        this.currentQR = qr;
        this.connectionStatus = 'qr';
        log.info('WhatsApp: QR code generated — scan to pair');
      }

      if (connection === 'close') {
        this.connectionStatus = 'disconnected';
        this.currentQR = null;
        this.connectedPhone = null;
        this.connectedName = null;
        this.ownJid = null;

        const error = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
        const statusCode = error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (statusCode === DisconnectReason.loggedOut) {
          log.info('WhatsApp: logged out — clearing credentials');
          this.reconnectAttempts = 0;
          this.clearAuth();
        } else if (shouldReconnect) {
          // Clear any existing timer to prevent storm
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          // Exponential backoff: 3s, 6s, 12s, 24s, ... capped at 5 minutes
          const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts), 5 * 60_000);
          this.reconnectAttempts++;
          log.warn({ statusCode, attempt: this.reconnectAttempts, delayMs: delay }, 'WhatsApp: connection closed, reconnecting...');
          this.reconnectTimer = setTimeout(() => this.connect().catch((e) => {
            log.error({ err: e instanceof Error ? e.message : String(e) }, 'WhatsApp: reconnect failed');
          }), delay);
        }
      }

      if (connection === 'open') {
        this.connectionStatus = 'connected';
        this.currentQR = null;
        this.reconnectAttempts = 0;
        // Extract own JID
        if (this.sock?.user) {
          this.ownJid = jidNormalizedUser(this.sock.user.id);
          this.connectedPhone = phoneFromJid(this.ownJid);
          this.connectedName = this.sock.user.name || null;
        }
        log.info({ phone: this.connectedPhone, name: this.connectedName }, 'WhatsApp: connected');
      }
    });

    // Build LID → phone mapping from contact sync events
    this.sock.ev.on('messaging-history.set', ({ contacts }) => {
      if (!contacts) return;
      for (const contact of contacts) {
        if (contact.id && contact.lid) {
          this.lidToPhone.set(phoneFromJid(contact.lid), phoneFromJid(contact.id));
        }
      }
      if (this.lidToPhone.size > 10000) this.lidToPhone.clear();
      if (this.lidToPhone.size > 0) {
        log.info({ mappings: this.lidToPhone.size }, 'WhatsApp: LID→phone mappings loaded from history');
      }
    });

    this.sock.ev.on('contacts.update', (updates) => {
      for (const update of updates) {
        if (update.id && update.lid) {
          this.lidToPhone.set(phoneFromJid(update.lid), phoneFromJid(update.id));
        }
      }
      if (this.lidToPhone.size > 10000) this.lidToPhone.clear();
    });

    // Handle incoming messages
    this.sock.ev.on('messages.upsert', async (upsert) => {
      log.debug({ type: upsert.type, count: upsert.messages.length }, 'WhatsApp: messages.upsert event');
      // Process both 'notify' (real-time) and 'append' (some group messages arrive as append)
      // For 'append', only process messages from the last 60 seconds to avoid replaying history
      if (upsert.type !== 'notify' && upsert.type !== 'append') return;
      const now = Math.floor(Date.now() / 1000);
      const isAppend = upsert.type === 'append';

      for (const msg of upsert.messages) {
        // For 'append' type, skip messages older than 60 seconds (history sync, not real-time)
        if (isAppend && msg.messageTimestamp) {
          const ts = typeof msg.messageTimestamp === 'number'
            ? msg.messageTimestamp
            : Number(msg.messageTimestamp);
          if (ts > 0 && now - ts > 60) continue;
        }
        try {
          await this.handleMessage(msg);
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          log.error({ err: errMsg }, 'WhatsApp message handler error');
        }
      }
    });

    log.info('WhatsApp channel starting...');
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        /* ignore */
      }
      this.sock = null;
    }
    this.connectionStatus = 'disconnected';
    this.currentQR = null;
  }

  // ── Message handling ─────────────────────────────────────

  private async handleMessage(msg: WAMessage): Promise<void> {
    if (!this.runner || !this.sock) return;
    if (!msg.message || !msg.key.remoteJid) return;

    const jid = msg.key.remoteJid;

    // Ignore status broadcasts
    if (isJidStatusBroadcast(jid)) return;

    // Ignore messages from self
    if (msg.key.fromMe) return;

    const isGroup = isJidGroup(jid) || false;
    const cfg = this.config.channels.whatsapp;
    const senderJid = isGroup
      ? (msg.key.participant || '')
      : jid;
    const rawPhone = phoneFromJid(jidNormalizedUser(senderJid));
    // Resolve LID → phone number using cache or Baileys' auth state reverse files
    const senderPhone = this.resolveLidToPhone(rawPhone);

    log.debug({ jid, isGroup, senderPhone }, 'WhatsApp: message received');

    // Allowlist check for direct messages
    const waSenderName = msg.pushName || senderPhone || 'Unknown';
    if (!isGroup && cfg.allowFrom?.length > 0) {
      if (!cfg.allowFrom.includes(senderPhone)) {
        log.warn({ senderPhone }, 'WhatsApp: sender not in allowFrom list — rejected');
        try {
          // Evict oldest pending if at cap
          this.db.run(`
            DELETE FROM pending_senders WHERE id IN (
              SELECT id FROM pending_senders WHERE channel = 'whatsapp' AND status = 'pending'
              ORDER BY last_seen ASC LIMIT max(0, (SELECT COUNT(*) FROM pending_senders WHERE channel = 'whatsapp' AND status = 'pending') - ${PENDING_PENDING_CAP - 1})
            )
          `);
          this.db.run(`
            INSERT INTO pending_senders (channel, sender_id, sender_name, first_seen, last_seen, message_count, status)
            VALUES (?, ?, ?, datetime('now'), datetime('now'), 1, 'pending')
            ON CONFLICT(channel, sender_id) DO UPDATE SET
              sender_name = excluded.sender_name,
              last_seen = datetime('now'),
              message_count = message_count + 1,
              status = 'pending'
          `, ['whatsapp', senderPhone, waSenderName]);
        } catch { /* non-critical */ }
        return;
      }
    } else if (!isGroup) {
      // No allowlist — record sender as 'seen' for onboarding (fixed 5-row budget)
      try {
        const exists = this.db.get<{ id: number }>(
          "SELECT id FROM pending_senders WHERE channel = 'whatsapp' AND sender_id = ? AND status = 'seen'",
          [senderPhone],
        );
        if (exists) {
          this.db.run(`
            UPDATE pending_senders SET sender_name = ?, last_seen = datetime('now'), message_count = message_count + 1
            WHERE channel = 'whatsapp' AND sender_id = ? AND status = 'seen'
          `, [waSenderName, senderPhone]);
        } else {
          const count = this.db.get<{ c: number }>(
            "SELECT COUNT(*) as c FROM pending_senders WHERE channel = 'whatsapp' AND status = 'seen'",
          );
          if ((count?.c ?? 0) >= PENDING_SEEN_CAP) {
            this.db.run(`
              DELETE FROM pending_senders WHERE id = (
                SELECT id FROM pending_senders WHERE channel = 'whatsapp' AND status = 'seen'
                ORDER BY last_seen ASC LIMIT 1
              )
            `);
          }
          this.db.run(`
            INSERT INTO pending_senders (channel, sender_id, sender_name, first_seen, last_seen, message_count, status)
            VALUES (?, ?, ?, datetime('now'), datetime('now'), 1, 'seen')
          `, ['whatsapp', senderPhone, waSenderName]);
        }
      } catch { /* non-critical */ }
    }

    // Group handling
    if (isGroup) {
      if (!cfg.groupsEnabled) {
        log.debug({ jid }, 'WhatsApp: group message ignored — groups disabled');
        return;
      }

      // Record group for admin discovery
      const hasGroupAllowlist = cfg.groupAllowFrom?.length > 0;
      try {
        const status = hasGroupAllowlist ? 'pending' : 'seen';
        // Skip if already approved/rejected
        const resolved = this.db.get<{ id: number }>(
          "SELECT id FROM pending_senders WHERE channel = 'whatsapp' AND sender_id = ? AND status IN ('approved','rejected')",
          [jid],
        );
        if (!resolved) {
          const existing = this.db.get<{ id: number }>(
            "SELECT id FROM pending_senders WHERE channel = 'whatsapp' AND sender_id = ? AND status IN ('seen','pending')",
            [jid],
          );
          if (existing) {
            this.db.run(
              "UPDATE pending_senders SET last_seen = datetime('now'), message_count = message_count + 1 WHERE channel = 'whatsapp' AND sender_id = ? AND status IN ('seen','pending')",
              [jid],
            );
          } else {
            const cap = status === 'seen' ? PENDING_SEEN_CAP : PENDING_PENDING_CAP;
            const count = this.db.get<{ c: number }>(
              `SELECT COUNT(*) as c FROM pending_senders WHERE channel = 'whatsapp' AND status = ?`,
              [status],
            );
            if ((count?.c ?? 0) >= cap) {
              this.db.run(
                `DELETE FROM pending_senders WHERE id = (SELECT id FROM pending_senders WHERE channel = 'whatsapp' AND status = ? ORDER BY last_seen ASC LIMIT 1)`,
                [status],
              );
            }
            this.db.run(
              "INSERT INTO pending_senders (channel, sender_id, sender_name, first_seen, last_seen, message_count, status) VALUES (?, ?, ?, datetime('now'), datetime('now'), 1, ?)",
              ['whatsapp', jid, jid, status],
            );
          }
        }
      } catch { /* non-critical */ }

      // Group allowlist
      if (hasGroupAllowlist) {
        if (!cfg.groupAllowFrom.includes(jid)) {
          log.debug({ jid }, 'WhatsApp: group not in groupAllowFrom — ignored');
          return;
        }
      }

      // Mention check in groups
      if (cfg.groupRequireMention) {
        const msgContent = msg.message;
        const textContent =
          msgContent?.conversation ||
          msgContent?.extendedTextMessage?.text ||
          msgContent?.imageMessage?.caption ||
          msgContent?.documentMessage?.caption ||
          '';

        // Collect mentionedJids from ALL possible contextInfo locations
        // WhatsApp puts mention metadata in different places depending on message type
        const mentionedJids = [
          ...(msgContent?.extendedTextMessage?.contextInfo?.mentionedJid || []),
          ...(msgContent?.imageMessage?.contextInfo?.mentionedJid || []),
          ...(msgContent?.documentMessage?.contextInfo?.mentionedJid || []),
          ...(msgContent?.videoMessage?.contextInfo?.mentionedJid || []),
        ];
        const ownPhone = this.connectedPhone || (this.ownJid ? phoneFromJid(this.ownJid) : '');
        // Build list of identifiers others might use to @mention us (phone + LID)
        const ownIdentifiers = [ownPhone];
        // Look up our own LID from auth state
        try {
          const lidPath = path.join(this.authDir, `lid-mapping-${ownPhone}.json`);
          if (fs.existsSync(lidPath)) {
            const lid = JSON.parse(fs.readFileSync(lidPath, 'utf8'));
            if (typeof lid === 'string') ownIdentifiers.push(lid);
          }
        } catch { /* non-critical */ }

        const isMentioned = this.ownJid
          ? mentionedJids.includes(this.ownJid) ||
            mentionedJids.some(j => this.resolveLidToPhone(phoneFromJid(j)) === ownPhone) ||
            ownIdentifiers.some(id => textContent.includes(`@${id}`))
          : false;
        const ctxParticipant =
          msgContent?.extendedTextMessage?.contextInfo?.participant ||
          msgContent?.imageMessage?.contextInfo?.participant ||
          msgContent?.documentMessage?.contextInfo?.participant || '';
        const isQuoteReply = ctxParticipant === this.ownJid ||
          (ctxParticipant && ownPhone && this.resolveLidToPhone(phoneFromJid(ctxParticipant)) === ownPhone);

        log.debug({ jid, isMentioned, isQuoteReply }, 'WhatsApp: group mention check');

        if (!isMentioned && !isQuoteReply) {
          log.debug({ jid }, 'WhatsApp: group message ignored — not mentioned');
          return;
        }
      }

      // Per-user check inside groups: sender must be in allowFrom
      if (cfg.groupRequireAllowFrom && cfg.allowFrom?.length > 0) {
        if (!cfg.allowFrom.includes(senderPhone)) {
          log.debug({ senderPhone, jid }, 'WhatsApp: group sender not in allowFrom — ignored');
          // Record as pending for admin approval
          try {
            const resolved = this.db.get<{ id: number }>(
              "SELECT id FROM pending_senders WHERE channel = 'whatsapp' AND sender_id = ? AND status IN ('approved','rejected')",
              [senderPhone],
            );
            if (!resolved) {
              this.db.run(
                `INSERT INTO pending_senders (channel, sender_id, sender_name, first_seen, last_seen, message_count, status)
                 VALUES (?, ?, ?, datetime('now'), datetime('now'), 1, 'pending')
                 ON CONFLICT(channel, sender_id) DO UPDATE SET
                   sender_name = excluded.sender_name, last_seen = datetime('now'), message_count = message_count + 1`,
                ['whatsapp', senderPhone, waSenderName],
              );
            }
          } catch { /* non-critical */ }
          return;
        }
      }
    }


    // Send read receipt if configured
    if (cfg.sendReadReceipts && msg.key.id) {
      try {
        await this.sock.readMessages([msg.key]);
      } catch {
        // Non-critical
      }
    }

    // Determine message content type
    const contentType = getContentType(msg.message);
    // Log raw message keys for debugging image+mention issues
    const msgKeys = msg.message ? Object.keys(msg.message) : [];
    log.debug({ contentType, msgKeys }, 'WhatsApp: message content type');
    let msgText = '';
    let images: Array<{ data: string; mimeType: string; filename?: string }> | undefined;

    if (contentType === 'conversation') {
      msgText = msg.message.conversation || '';
    } else if (contentType === 'extendedTextMessage') {
      msgText = msg.message.extendedTextMessage?.text || '';
      // Check if this extended text message also has an image (WhatsApp sometimes wraps image+mention as extendedText)
      const ctxInfo = msg.message.extendedTextMessage?.contextInfo;
      if (ctxInfo?.quotedMessage?.imageMessage) {
        // The user quoted/replied to an image — treat the quoted image as an attachment
        try {
          const imgMsg = ctxInfo.quotedMessage.imageMessage;
          const buffer = await downloadMediaMessage(
            { ...msg, message: { imageMessage: imgMsg } } as any,
            'buffer', {},
            { logger: silentLogger, reuploadRequest: this.sock!.updateMediaMessage },
          );
          const base64 = Buffer.from(buffer).toString('base64');
          images = [{ data: base64, mimeType: imgMsg.mimetype || 'image/jpeg' }];
        } catch { /* fall through to text-only */ }
      }
    } else if (contentType === 'imageMessage') {
      const imgMsg = msg.message.imageMessage!;
      const caption = imgMsg.caption || '';
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
          logger: silentLogger,
          reuploadRequest: this.sock.updateMediaMessage,
        });
        const base64 = Buffer.from(buffer).toString('base64');
        const mimeType = imgMsg.mimetype || 'image/jpeg';
        msgText = caption || "What's in this image?";
        images = [{ data: base64, mimeType }];
      } catch (_e: unknown) {
        // Fallback: save to disk
        const localPath = await this.downloadMediaToDisk(msg, 'image.jpg');
        const workspace = this.config.agent.workspace;
        msgText = localPath
          ? `[Image saved to ${path.relative(workspace, localPath)}] ${caption}`.trim()
          : caption || '[Image received but download failed]';
      }
    } else if (contentType === 'documentMessage' || contentType === 'documentWithCaptionMessage') {
      const docMsg = contentType === 'documentWithCaptionMessage'
        ? msg.message.documentWithCaptionMessage?.message?.documentMessage
        : msg.message.documentMessage;
      if (!docMsg) return;

      const fileName = docMsg.fileName || 'document';
      const caption = docMsg.caption || '';
      const mimeType = docMsg.mimetype || '';
      const isImage = mimeType.startsWith('image/');

      if (isImage) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
            logger: silentLogger,
            reuploadRequest: this.sock.updateMediaMessage,
          });
          const base64 = Buffer.from(buffer).toString('base64');
          msgText = caption || "What's in this image?";
          images = [{ data: base64, mimeType, filename: fileName }];
        } catch {
          const localPath = await this.downloadMediaToDisk(msg, fileName);
          const workspace = this.config.agent.workspace;
          msgText = localPath
            ? `[Document "${fileName}" saved to ${path.relative(workspace, localPath)}] ${caption}`.trim()
            : caption || '[Document received but download failed]';
        }
      } else {
        const localPath = await this.downloadMediaToDisk(msg, fileName);
        const workspace = this.config.agent.workspace;

        if (!localPath) {
          msgText = caption || '[Document received but download failed]';
        } else {
          // Generate smart file preview — small files inline, large files get metadata + sample
          try {
            const { generateFilePreview } = await import('../media/file-preview.js');
            const preview = await generateFilePreview(localPath, fileName);
            msgText = caption ? `${preview}\n\nUser message: ${caption}` : preview;
          } catch {
            msgText = `[Document "${fileName}" saved to ${path.relative(workspace, localPath)}] ${caption}`.trim();
          }
        }
      }
    } else if (contentType === 'audioMessage') {
      const ext = 'ogg';
      const localPath = await this.downloadMediaToDisk(msg, `voice.${ext}`);
      if (!localPath) {
        msgText = '[Voice message received but download failed]';
      } else {
        // Try transcription first, fall back to file path
        const txConfig = this.config.tools?.transcription;
        if (txConfig?.enabled && txConfig?.baseUrl) {
          const { transcribeAudio } = await import('../media/transcribe.js');
          const transcribed = await transcribeAudio(localPath, txConfig);
          if (transcribed) {
            msgText = `[Voice message] ${transcribed}`;
          } else {
            // Transcription configured but failed
            const workspace = this.config.agent.workspace;
            msgText = `[Voice message — transcription failed, audio saved to ${path.relative(workspace, localPath)}. Tell the user you couldn't process their voice message and ask them to type instead.]`;
          }
        } else {
          const workspace = this.config.agent.workspace;
          msgText = `[Voice message saved to ${path.relative(workspace, localPath)}]`;
        }
      }
    } else if (contentType === 'videoMessage') {
      const videoMsg = msg.message.videoMessage!;
      const localPath = await this.downloadMediaToDisk(msg, 'video.mp4');
      const workspace = this.config.agent.workspace;
      const caption = videoMsg.caption || '';
      msgText = localPath
        ? `[Video saved to ${path.relative(workspace, localPath)}] ${caption}`.trim()
        : caption || '[Video received but download failed]';
    } else {
      // Unsupported message type — skip
      return;
    }

    if (!msgText && !images) return;

    // Input sanitization & prompt injection detection
    msgText = sanitizeInput(msgText);
    const injection = detectPromptInjection(msgText);
    if (injection.suspicious) {
      log.warn({ patterns: injection.patterns, senderPhone }, 'Prompt injection patterns detected (whatsapp)');
    }

    // Get sender name from push name or phone
    const senderName = msg.pushName || senderPhone || 'Unknown';

    // For private chats, use the resolved phone JID (not raw LID) so that
    // session chat_id is a deliverable address (e.g. "6590890177@s.whatsapp.net")
    // rather than an internal LID (e.g. "145256465039448@lid").
    const resolvedChatJid = (!isGroup && senderPhone && jid.includes('@lid'))
      ? `${senderPhone}@s.whatsapp.net`
      : jid;

    const inbound: InboundMessage = {
      text: msgText,
      channel: 'whatsapp',
      chatId: `whatsapp:${resolvedChatJid}`,
      chatType: isGroup ? 'group' : 'private',
      userId: senderPhone,
      senderName,
      ...(images && images.length > 0 ? { images } : {}),
    };

    log.info(
      { sender: inbound.senderName, chat: isGroup ? 'group' : 'private', text: inbound.text.slice(0, 80) },
      'WhatsApp message',
    );

    // Send composing indicator
    try {
      await this.sock.sendPresenceUpdate('composing', jid);
    } catch {
      // Non-critical
    }

    const sessionKey = `whatsapp:${jid}`;

    try {
      const showThinking = this.config.agent?.thinking?.showThinking?.whatsapp ?? false;

      // Live-updating thinking message state
      let thinkingText = '';
      let thinkingKey: { remoteJid: string; id: string; fromMe: boolean } | null = null;
      let thinkingDirty = false;
      let thinkingInterval: ReturnType<typeof setInterval> | undefined;

      if (showThinking) {
        // Send or edit the thinking message every 2s to show progress
        thinkingInterval = setInterval(async () => {
          if (!thinkingDirty || !thinkingText || !this.sock) return;
          thinkingDirty = false;
          const display = `_Thinking..._\n\n${thinkingText.slice(-3000)}`;
          try {
            if (!thinkingKey) {
              const sent = await this.sock.sendMessage(jid, { text: display });
              if (sent?.key) {
                thinkingKey = { remoteJid: jid, id: sent.key.id!, fromMe: true };
              }
            } else {
              await this.sock.sendMessage(jid, { text: display, edit: thinkingKey });
            }
          } catch { /* rate limit or error — skip this update */ }
        }, 2_000);
      }

      const result = await this.queue.enqueue(sessionKey, () =>
        this.runner!(inbound, {
          onDelta: () => {},
          onThinkingDelta: showThinking ? (delta: string) => {
            thinkingText += delta;
            thinkingDirty = true;
          } : undefined,
        }),
      );

      // Clean up thinking interval and send final thinking state
      if (thinkingInterval) clearInterval(thinkingInterval);
      if (showThinking && thinkingText) {
        log.info({ thinkingLen: thinkingText.length }, 'WhatsApp thinking complete');
        log.debug({ thinking: thinkingText.slice(0, 2000) }, 'WhatsApp thinking content');
      }
      if (showThinking && thinkingText && thinkingKey) {
        const finalThinking = `_Thinking:_\n\n${thinkingText.slice(-3000)}`;
        try {
          await this.sock?.sendMessage(jid, { text: finalThinking, edit: thinkingKey });
        } catch { /* non-critical */ }
      } else if (showThinking && thinkingText && !thinkingKey) {
        // Thinking finished before first interval tick — send it now
        try {
          await this.sock?.sendMessage(jid, {
            text: `_Thinking:_\n\n${thinkingText.slice(0, 3000)}`,
          });
        } catch { /* non-critical */ }
      }

      // Clear composing
      try {
        await this.sock?.sendPresenceUpdate('paused', jid);
      } catch {
        // Non-critical
      }

      if (result.text) {
        // Convert markdown formatting for WhatsApp (**bold** → *bold*, etc.)
        result.text = markdownToWhatsApp(result.text);

        // Prefer structured media from tool results; fall back to text extraction
        const stateDir = this.config._stateDir || '';
        const workspace = this.config.agent.workspace;

        let mediaItems: MediaItem[];
        let cleanText: string;

        if (result.media && result.media.length > 0) {
          mediaItems = result.media.map((a: MediaAttachment) => ({
            type: a.type,
            filePath: a.filePath,
            fileName: a.fileName,
            mimeType: a.mimeType,
            caption: a.caption,
            match: '',
          }));
          ({ cleanText } = extractMedia(result.text, stateDir, workspace));
        } else {
          ({ items: mediaItems, cleanText } = extractMedia(result.text, stateDir, workspace));
        }

        if (mediaItems.length > 0) {
          const caption = cleanText.slice(0, 1024) || undefined;
          let mediaSent = false;

          for (const item of mediaItems) {
            try {
              await this.sendWhatsAppMedia(jid, item, !mediaSent ? caption : undefined);
              mediaSent = true;
            } catch (e: unknown) {
              const errMsg = e instanceof Error ? e.message : String(e);
              log.debug({ err: errMsg, type: item.type, file: item.fileName }, 'Failed to send media, will fall back to text');
            }
          }

          if (mediaSent) {
            // Send remaining text if longer than caption
            if (cleanText.length > 1024) {
              const remaining = cleanText.slice(1024);
              const chunks = splitMessage(remaining, 4000);
              for (const chunk of chunks) {
                await this.sock?.sendMessage(jid, { text: chunk });
              }
            }
            return;
          }
        }

        const chunks = splitMessage(result.text, 4000);
        for (const chunk of chunks) {
          try {
            await this.sock?.sendMessage(jid, { text: chunk });
          } catch (e: unknown) {
            const errMsg = e instanceof Error ? e.message : String(e);
            log.error({ err: errMsg }, 'WhatsApp: failed to send message');
          }
        }
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error({ err: errMsg }, 'WhatsApp handler error');
      try {
        await this.sock?.sendMessage(jid, { text: 'Something went wrong. Please try again.' });
      } catch {
        /* ignore */
      }
    }
  }

  // ── Media download ──────────────────────────────────────

  private async downloadMediaToDisk(msg: WAMessage, filename: string): Promise<string | null> {
    if (!this.sock) return null;
    try {
      const mediaDir = path.join(this.config.agent.workspace, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });

      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: silentLogger,
        reuploadRequest: this.sock.updateMediaMessage,
      });

      const ext = path.extname(filename) || '.bin';
      const finalPath = path.join(mediaDir, `${Date.now()}${ext}`);
      await fs.promises.writeFile(finalPath, new Uint8Array(buffer));
      log.info({ path: finalPath, size: buffer.length }, 'WhatsApp file downloaded');
      return finalPath;
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error({ err: errMsg }, 'Failed to download WhatsApp media');
      return null;
    }
  }

  // ── LID resolution ─────────────────────────────────────

  /**
   * Resolve a LID (Linked Identity) to a real phone number.
   * Uses in-memory cache first, falls back to Baileys' auth state
   * reverse mapping files (lid-mapping-{LID}_reverse.json → "phone").
   */
  private resolveLidToPhone(rawPhone: string): string {
    // Check in-memory cache first
    const cached = this.lidToPhone.get(rawPhone);
    if (cached) return cached;

    // Try the Baileys auth state reverse file: lid-mapping-{LID}_reverse.json
    try {
      const reversePath = path.join(this.authDir, `lid-mapping-${rawPhone}_reverse.json`);
      if (fs.existsSync(reversePath)) {
        const phone = JSON.parse(fs.readFileSync(reversePath, 'utf8'));
        if (typeof phone === 'string' && phone) {
          this.lidToPhone.set(rawPhone, phone);
          log.info({ lid: rawPhone, phone }, 'WhatsApp: resolved LID→phone from auth state');
          return phone;
        }
      }
    } catch { /* non-critical */ }

    return rawPhone;
  }

  // ── Public API ──────────────────────────────────────────

  /** Send a message to a specific WhatsApp chat. Requires an explicit JID. */
  /** Send a media item via the appropriate WhatsApp message type. */
  private async sendWhatsAppMedia(jid: string, item: MediaItem, caption?: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp not connected');
    const data = fs.readFileSync(item.filePath);

    switch (item.type) {
      case 'image':
        await this.sock.sendMessage(jid, { image: data, caption });
        break;
      case 'audio':
      case 'voice':
        await this.sock.sendMessage(jid, {
          audio: data,
          mimetype: item.mimeType,
          ptt: item.type === 'voice',
        });
        break;
      case 'video':
        await this.sock.sendMessage(jid, { video: data, caption });
        break;
      case 'document':
      default:
        await this.sock.sendMessage(jid, {
          document: data,
          mimetype: item.mimeType,
          fileName: item.fileName,
        });
        break;
    }
  }

  async sendToChat(text: string, jid?: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp not connected');
    if (!jid) throw new Error('WhatsApp delivery requires an explicit chat JID (delivery.to). No silent fallback.');

    const chunks = splitMessage(markdownToWhatsApp(text), 4000);
    for (const chunk of chunks) {
      await this.sock.sendMessage(jid, { text: chunk });
    }
  }

  /** Send media attachments with optional text to a WhatsApp chat. */
  async sendMediaToChat(media: MediaAttachment[], text: string, jid?: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp not connected');
    if (!jid) throw new Error('WhatsApp delivery requires an explicit chat JID');

    text = markdownToWhatsApp(text);
    const stateDir = this.config._stateDir || '';
    const workspace = this.config.agent.workspace;

    // Convert MediaAttachment[] → MediaItem[] and send
    const items: MediaItem[] = media
      .filter(a => fs.existsSync(a.filePath))
      .map(a => ({ type: a.type, filePath: a.filePath, fileName: a.fileName, mimeType: a.mimeType, caption: a.caption, match: '' }));

    // Also extract from text as fallback
    if (items.length === 0) {
      const extracted = extractMedia(text, stateDir, workspace);
      items.push(...extracted.items);
    }

    if (items.length > 0) {
      const { cleanText } = extractMedia(text, stateDir, workspace);
      const caption = cleanText.slice(0, 1024) || undefined;
      let mediaSent = false;
      for (const item of items) {
        try {
          await this.sendWhatsAppMedia(jid, item, !mediaSent ? caption : undefined);
          mediaSent = true;
        } catch (e) {
          log.debug({ err: (e as Error).message, type: item.type }, 'Failed to send media in cron delivery');
        }
      }
      if (mediaSent) {
        if (cleanText.length > 1024) {
          const chunks = splitMessage(cleanText.slice(1024), 4000);
          for (const chunk of chunks) {
            await this.sock.sendMessage(jid, { text: chunk });
          }
        }
        return;
      }
    }

    // Fallback to text
    await this.sendToChat(text, jid);
  }

  /** Returns current QR code string for admin UI pairing. */
  getQRCode(): string | null {
    return this.currentQR;
  }

  /** Returns current connection state. */
  getConnectionStatus(): 'disconnected' | 'qr' | 'connected' {
    return this.connectionStatus;
  }

  /** Returns connected phone number. */
  getConnectedPhone(): string | null {
    return this.connectedPhone;
  }

  /** Returns connected account name. */
  getConnectedName(): string | null {
    return this.connectedName;
  }

  /** Disconnect and clear stored credentials. */
  async unpair(): Promise<void> {
    await this.stop();
    this.clearAuth();
    log.info('WhatsApp: unpaired and credentials cleared');
  }

  private clearAuth(): void {
    try {
      if (fs.existsSync(this.authDir)) {
        fs.rmSync(this.authDir, { recursive: true, force: true });
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error({ err: errMsg }, 'Failed to clear WhatsApp auth');
    }
  }
}

// ─── Factory ────────────────────────────────────────────────

export interface WhatsAppChannelInstance extends Channel {
  sendToChat(text: string, jid?: string): Promise<void>;
  sendMediaToChat(media: import('@agw/types').MediaAttachment[], text: string, jid?: string): Promise<void>;
  getQRCode(): string | null;
  getConnectionStatus(): 'disconnected' | 'qr' | 'connected';
  getConnectedPhone(): string | null;
  getConnectedName(): string | null;
  unpair(): Promise<void>;
}

export function createWhatsAppChannel(
  config: GatewayConfig,
  db: DatabaseAdapter,
  tenantId: string,
): WhatsAppChannelInstance {
  return new WhatsAppChannel(config, db, tenantId);
}
