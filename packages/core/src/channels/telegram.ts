/**
 * Telegram channel — Grammy bot integration.
 *
 * Implements the Channel interface for Telegram. Handles text, photo,
 * document, and voice messages. Supports allowlist filtering and
 * per-session request queuing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Bot, InputFile } from 'grammy';
import { PENDING_SEEN_CAP, PENDING_PENDING_CAP } from '../constants.js';
import { extractMedia } from '../media/detector.js';
import type { MediaItem } from '../media/detector.js';
import type { Context } from 'grammy';
import type { GatewayConfig, InboundMessage, MediaAttachment } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import { PendingSenderRepository } from '../db/repositories/pending-sender.js';
import type { SecretsStore } from '../secrets/store.js';
import type { Channel, AgentRunner } from './types.js';
import { AgentQueue } from '../queue/index.js';
import { splitMessage, appendModelIndicator, shouldShowModelIndicator } from './utils.js';
import { markdownToTelegramHtml, escHtml } from './markdown.js';
import { createModuleLogger } from '../observability/logger.js';
import { sanitizeInput, detectPromptInjection, prefixInjectionWarning } from '@agw/security';

const log = createModuleLogger('channel.telegram');

// ─── Helpers ────────────────────────────────────────────────

/**
 * Send a message with retry and exponential backoff for Telegram rate limits.
 */
const TG_SAFE_TAGS = /^(?:b|i|s|u|code|pre|a|blockquote|tg-spoiler)$/;

async function sendWithRetry(
  ctx: Context,
  text: string,
  options: Record<string, unknown> = {},
  maxRetries = 3,
): Promise<unknown> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await ctx.reply(text, options);
    } catch (e: unknown) {
      const err = e as { error_code?: number; message?: string; parameters?: { retry_after?: number } };
      if (err.error_code === 429 || err.message?.includes('Too Many Requests')) {
        const retryAfter = err.parameters?.retry_after || 2 ** attempt;
        log.warn({ retryAfter, attempt }, 'Telegram rate limit, retrying');
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (attempt === 0 && options.parse_mode && /can't parse|parse entities|find end of the entity/i.test(err.message || '')) {
        // Tier 2: strip unsupported tags, keep safe ones
        const safeHtml = text.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tag) =>
          TG_SAFE_TAGS.test(tag.toLowerCase()) ? match : '');
        try {
          return await ctx.reply(safeHtml, options);
        } catch {
          // Tier 3: strip all formatting, send plain text
          const plain = text.replace(/<[^>]+>/g, '');
          const { parse_mode: _, ...rest } = options;
          return sendWithRetry(ctx, plain, rest, maxRetries - 1);
        }
      }
      throw e;
    }
  }
}

// ─── TelegramChannel class ─────────────────────────────────

class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private bot: Bot | null = null;
  private runner: AgentRunner | null = null;
  private readonly queue = new AgentQueue();
  private readonly config: GatewayConfig;
  private readonly db: DatabaseAdapter;
  private readonly tenantId: string;
  private readonly secretsStore?: SecretsStore;
  private readonly pendingSenders: PendingSenderRepository;
  private resolvedBotToken: string = '';

  // Media group buffering: Telegram sends album photos as separate events.
  // We buffer them by media_group_id and flush after a debounce window.
  private mediaGroupBuffer = new Map<string, {
    images: Array<{ data: string; mimeType: string; filename?: string }>;
    caption: string;
    ctx: Context;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private static readonly MEDIA_GROUP_DEBOUNCE_MS = 500;

  constructor(config: GatewayConfig, db: DatabaseAdapter, tenantId: string, secretsStore?: SecretsStore) {
    this.config = config;
    this.db = db;
    this.tenantId = tenantId;
    this.secretsStore = secretsStore;
    this.pendingSenders = new PendingSenderRepository(db);
  }

  /**
   * Buffer an image for a media group (album). When the debounce timer
   * fires, all images are flushed as a single handleMessage call.
   */
  private bufferMediaGroupImage(
    mediaGroupId: string,
    ctx: Context,
    image: { data: string; mimeType: string; filename?: string },
    caption: string,
  ): void {
    const existing = this.mediaGroupBuffer.get(mediaGroupId);
    if (existing) {
      existing.images.push(image);
      if (caption && !existing.caption) existing.caption = caption;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), TelegramChannel.MEDIA_GROUP_DEBOUNCE_MS);
    } else {
      const timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), TelegramChannel.MEDIA_GROUP_DEBOUNCE_MS);
      this.mediaGroupBuffer.set(mediaGroupId, { images: [image], caption, ctx, timer });
    }
  }

  private flushMediaGroup(mediaGroupId: string): void {
    const group = this.mediaGroupBuffer.get(mediaGroupId);
    if (!group) return;
    this.mediaGroupBuffer.delete(mediaGroupId);

    const text = group.caption || `What's in ${group.images.length === 1 ? 'this image' : `these ${group.images.length} images`}?`;
    this.handleMessage(group.ctx, text, group.images).catch((e) => {
      log.error({ err: e instanceof Error ? e.message : String(e), mediaGroupId }, 'Failed to handle media group');
    });
  }

  async start(runner: AgentRunner): Promise<void> {
    const cfg = this.config.channels.telegram;
    const botToken = this.secretsStore?.get('channels.telegram', 'botToken') || cfg.botToken;
    if (!cfg.enabled || !botToken) {
      log.info('Telegram channel disabled or no bot token');
      return;
    }

    this.runner = runner;
    this.resolvedBotToken = botToken;
    this.bot = new Bot(botToken);

    // ── Middleware: record senders for discovery ──
    // Runs before commands and message handlers so /myid etc. also get tracked
    this.bot.use(async (ctx, next) => {
      if (ctx.from && ctx.chat?.type === 'private') {
        const senderId = String(ctx.from.id);
        const senderName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Unknown';
        const cfg = this.config.channels.telegram;
        if (!cfg.allowFrom || cfg.allowFrom.length === 0) {
          // No allowlist — record as 'seen' for onboarding (capped budget)
          try {
            await this.pendingSenders.recordSighting('telegram', senderId, senderName, 'seen', PENDING_SEEN_CAP);
          } catch { /* non-critical */ }
        }
      }
      await next();
    });

    // ── Slash commands ───────────────────────────
    this.bot.command('start', async (ctx) => {
      const name = this.config.agent?.name || 'Kairo';
      await ctx.reply(`Hi! I'm ${name}, your AI assistant. Send me a message to get started.\n\nType /help to see available commands.`);
    });

    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        '<b>Commands</b>\n\n' +
        '/start — Welcome message\n' +
        '/new — Start fresh session (clears history)\n' +
        '/status — Show session info\n' +
        '/compact — Compress long conversations\n' +
        '/model — Show or switch AI model\n' +
        '/help — Show this list\n' +
        '/myid — Show your Telegram user ID\n\n' +
        'Or just send any message to chat.',
        { parse_mode: 'HTML' },
      );
    });

    this.bot.command('myid', async (ctx) => {
      if (!ctx.from) return;
      const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
      await ctx.reply(
        `Your Telegram user ID: <code>${ctx.from.id}</code>\n` +
        (name ? `Name: ${name}\n` : '') +
        `\nPaste this ID into <b>Allowed Users</b> on the admin Channels page to grant access.`,
        { parse_mode: 'HTML' },
      );
    });

    this.bot.command('groupid', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') {
        await ctx.reply('This command only works in groups.');
        return;
      }
      const title = ctx.chat.title || 'this group';
      await ctx.reply(
        `Group ID: <code>${ctx.chat.id}</code>\nName: ${title}\n\n` +
        `Paste this ID into <b>Allowed Groups</b> on the admin Channels page to grant access.`,
        { parse_mode: 'HTML' },
      );
    });

    // Clear any old commands then set only ours
    this.bot.api.deleteMyCommands().catch(() => {});
    this.bot.api.setMyCommands([
      { command: 'start', description: 'Welcome message' },
      { command: 'new', description: 'Start fresh session (clears history)' },
      { command: 'status', description: 'Show session info' },
      { command: 'compact', description: 'Compress long conversations' },
      { command: 'help', description: 'List available commands' },
      { command: 'myid', description: 'Show your Telegram user ID' },
      { command: 'groupid', description: 'Show this group\'s chat ID' },
    ]).catch(() => { /* non-critical */ });

    // ── Text messages ────────────────────────────
    this.bot.on('message:text', (ctx) => this.handleMessage(ctx));

    // ── Photo messages ───────────────────────────
    this.bot.on('message:photo', async (ctx) => {
      const photo = ctx.message.photo;
      if (!photo || photo.length === 0) return;
      const largest = photo[photo.length - 1]!;
      const imageData = await this.downloadFileAsBase64(largest.file_id);
      const caption = ctx.message.caption || '';

      if (imageData) {
        const mediaGroupId = (ctx.message as { media_group_id?: string }).media_group_id;
        if (mediaGroupId) {
          this.bufferMediaGroupImage(mediaGroupId, ctx, { data: imageData, mimeType: 'image/jpeg' }, caption);
          return;
        }
        const text = caption || "What's in this image?";
        await this.handleMessage(ctx, text, [{ data: imageData, mimeType: 'image/jpeg' }]);
      } else {
        const localPath = await this.downloadFile(largest.file_id, 'photo.jpg', ctx.from?.id ? String(ctx.from.id) : undefined);
        const workspace = this.config.agent.workspace;
        const text = localPath
          ? `[Image saved to ${path.relative(workspace, localPath)}] ${caption}`.trim()
          : caption || '[Photo received but download failed]';
        await this.handleMessage(ctx, text);
      }
    });

    // ── Document messages ────────────────────────
    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      if (!doc) return;

      // Check if the document is an image
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
      const fileName = doc.file_name || '';
      const ext = path.extname(fileName).toLowerCase();
      const isImage = imageExts.includes(ext) || doc.mime_type?.startsWith('image/');

      if (isImage) {
        const imageData = await this.downloadFileAsBase64(doc.file_id);
        const caption = ctx.message.caption || '';
        if (imageData) {
          const mimeType = doc.mime_type || `image/${ext.slice(1) || 'jpeg'}`;
          const mediaGroupId = (ctx.message as { media_group_id?: string }).media_group_id;
          if (mediaGroupId) {
            this.bufferMediaGroupImage(mediaGroupId, ctx, { data: imageData, mimeType, filename: fileName }, caption);
            return;
          }
          const text = caption || "What's in this image?";
          await this.handleMessage(ctx, text, [{ data: imageData, mimeType, filename: fileName }]);
          return;
        }
      }

      // Non-image document or image download failed: save to disk
      const localPath = await this.downloadFile(doc.file_id, doc.file_name || 'document', ctx.from?.id ? String(ctx.from.id) : undefined);
      const caption = ctx.message.caption || '';
      const workspace = this.config.agent.workspace;

      if (!localPath) {
        await this.handleMessage(ctx, caption || '[Document received but download failed]');
        return;
      }

      // Generate smart file preview — small files inline, large files get metadata + sample
      try {
        const { generateFilePreview } = await import('../media/file-preview.js');
        const preview = await generateFilePreview(localPath, doc.file_name || 'document');
        const text = caption ? `${preview}\n\nUser message: ${caption}` : preview;
        await this.handleMessage(ctx, text);
      } catch {
        const text = `[Document "${doc.file_name}" saved to ${path.relative(workspace, localPath)}] ${caption}`.trim();
        await this.handleMessage(ctx, text);
      }
    });

    // ── Voice messages ───────────────────────────
    this.bot.on('message:voice', async (ctx) => {
      const voice = ctx.message.voice;
      if (!voice) return;
      const localPath = await this.downloadFile(voice.file_id, 'voice.ogg', ctx.from?.id ? String(ctx.from.id) : undefined);
      if (!localPath) {
        await this.handleMessage(ctx, '[Voice message received but download failed]');
        return;
      }

      // Try transcription first, fall back to file path with explanation
      const txConfig = this.config.tools?.transcription;
      if (txConfig?.enabled && txConfig?.baseUrl) {
        const { transcribeAudio } = await import('../media/transcribe.js');
        const transcribed = await transcribeAudio(localPath, txConfig);
        if (transcribed) {
          await this.handleMessage(ctx, `[Voice message] ${transcribed}`);
          return;
        }
        // Transcription configured but failed — tell the agent
        const workspace = this.config.agent.workspace;
        await this.handleMessage(ctx, `[Voice message — transcription failed, audio saved to ${path.relative(workspace, localPath)}. Tell the user you couldn't process their voice message and ask them to type instead.]`);
        return;
      }

      const workspace = this.config.agent.workspace;
      await this.handleMessage(ctx, `[Voice message saved to ${path.relative(workspace, localPath)}]`);
    });

    // ── Error handler ────────────────────────────
    this.bot.catch((err) => {
      log.error({ err: err.message }, 'Grammy error');
    });

    this.bot.start();
    log.info('Telegram bot started');
  }

  async stop(): Promise<void> {
    // Flush pending media groups before shutdown so images aren't lost
    for (const [id, group] of this.mediaGroupBuffer) {
      clearTimeout(group.timer);
      this.mediaGroupBuffer.delete(id);
    }
    this.mediaGroupBuffer.clear();

    if (this.bot) {
      try {
        this.bot.stop();
      } catch {
        /* ignore */
      }
      this.bot = null;
    }
  }

  // ── Message handling ─────────────────────────────────────

  private async handleMessage(ctx: Context, overrideText?: string, images?: Array<{ data: string; mimeType: string; filename?: string }>): Promise<void> {
    if (!ctx.from || !ctx.chat || !ctx.message) return;
    if (!this.runner) return;

    // Track last active chat for send_message tool
    this.lastActiveChatId = String(ctx.chat.id);

    const senderId = String(ctx.from.id);
    const chatId = String(ctx.chat.id);
    const chatType = ctx.chat.type === 'private' ? 'private' as const : 'group' as const;
    const cfg = this.config.channels.telegram;

    // Allowlist check — compare as strings to handle mixed types
    const allowSet = cfg.allowFrom?.length > 0 ? new Set(cfg.allowFrom.map(String)) : null;
    const groupAllowSet = cfg.groupAllowFrom?.length > 0 ? new Set(cfg.groupAllowFrom.map(String)) : null;
    const senderName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Unknown';
    if (allowSet) {
      if (!allowSet.has(senderId)) {
        log.warn({ senderId }, 'Telegram: sender not in allowFrom list — rejected');
        try {
          // Evict oldest pending if at cap
          await this.pendingSenders.evictOverCap('telegram', 'pending', PENDING_PENDING_CAP);
          await this.pendingSenders.upsert('telegram', senderId, senderName, 'pending');
        } catch { /* non-critical */ }
        return;
      }
    }
    // 'seen' recording handled by middleware (runs for commands + messages)

    // Group handling
    if (chatType === 'group') {
      if (!cfg.groupsEnabled) return;

      // Record group for admin discovery
      const groupName = ctx.chat?.title || `Group ${chatId}`;
      try {
        const status = groupAllowSet ? 'pending' : 'seen';
        const cap = status === 'seen' ? PENDING_SEEN_CAP : PENDING_PENDING_CAP;
        await this.pendingSenders.recordWithResolutionCheck('telegram', chatId, groupName, status, cap);
      } catch { /* non-critical */ }

      // Group allowlist (if set, only listed group IDs are allowed)
      if (groupAllowSet) {
        if (!groupAllowSet.has(chatId)) {
          log.debug({ chatId }, 'Telegram: group not in groupAllowFrom — ignored');
          return;
        }
      }

      if (cfg.groupRequireMention && this.bot) {
        const botInfo = this.bot.botInfo;
        const text = ctx.message.text || ctx.message.caption || '';
        const mentioned = botInfo.username ? text.includes(`@${botInfo.username}`) : false;
        const replied = ctx.message.reply_to_message?.from?.id === botInfo.id;
        if (!mentioned && !replied) return;
      }

      // Per-user check inside groups: sender must be in allowFrom
      if (cfg.groupRequireAllowFrom && allowSet) {
        if (!allowSet.has(senderId)) {
          log.debug({ senderId, chatId }, 'Telegram: group sender not in allowFrom — ignored');
          // Record as pending for admin approval
          try {
            const senderName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Unknown';
            const resolved = await this.pendingSenders.findBySenderId('telegram', senderId, ['approved', 'rejected']);
            if (!resolved) {
              await this.pendingSenders.upsert('telegram', senderId, senderName, 'pending');
            }
          } catch { /* non-critical */ }
          return;
        }
      }
    }

    const rawText = overrideText || ctx.message.text || '';
    let msgText = sanitizeInput(rawText);
    const injection = detectPromptInjection(msgText);
    if (injection.suspicious) {
      log.warn({ patterns: injection.patterns, severity: injection.maxSeverity, senderId }, 'Prompt injection patterns detected (telegram)');
      if (injection.maxSeverity === 'block') {
        await ctx.reply('Message rejected: suspicious input pattern detected.');
        return;
      }
      msgText = prefixInjectionWarning(msgText, injection.patterns);
    }

    const inbound: InboundMessage = {
      text: msgText,
      channel: 'telegram',
      chatId: `telegram:${chatId}`,
      chatType,
      userId: senderId,
      senderName:
        [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Unknown',
      ...(images && images.length > 0 ? { images } : {}),
    };

    log.info(
      { sender: inbound.senderName, chat: chatType, text: inbound.text.slice(0, 80) },
      'Telegram message',
    );

    // Send typing indicator, keep refreshing for long tool chains
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    try {
      await ctx.replyWithChatAction('typing');
      typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4_000);
    } catch {
      // Typing indicator is non-critical
    }

    const sessionKey = `telegram:${chatId}`;

    try {
      const showThinking = this.config.agent?.thinking?.showThinking?.telegram ?? false;

      // Live-updating thinking message state
      let thinkingText = '';
      let thinkingMsgId: number | null = null;
      let thinkingDirty = false;
      let thinkingInterval: ReturnType<typeof setInterval> | undefined;

      if (showThinking) {
        // Edit the thinking message every 2s to show progress
        thinkingInterval = setInterval(async () => {
          if (!thinkingDirty || !thinkingText) return;
          thinkingDirty = false;
          const display = `<i>Thinking...</i>\n\n${escHtml(thinkingText.slice(-3000))}`;
          try {
            if (!thinkingMsgId) {
              const sent = await ctx.reply(display, {
                parse_mode: 'HTML',
                reply_parameters:
                  chatType === 'group' && ctx.message
                    ? { message_id: ctx.message.message_id }
                    : undefined,
              });
              thinkingMsgId = sent.message_id;
            } else {
              await ctx.api.editMessageText(ctx.chat!.id, thinkingMsgId, display, {
                parse_mode: 'HTML',
              });
            }
          } catch { /* rate limit or parse error — skip this update */ }
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
        log.info({ thinkingLen: thinkingText.length }, 'Telegram thinking complete');
        log.debug({ thinking: thinkingText.slice(0, 2000) }, 'Telegram thinking content');
      }
      if (showThinking && thinkingText && thinkingMsgId) {
        // Final edit with complete thinking
        const finalThinking = `<i>Thinking:</i>\n\n${escHtml(thinkingText.slice(-3000))}`;
        try {
          await ctx.api.editMessageText(ctx.chat!.id, thinkingMsgId, finalThinking, {
            parse_mode: 'HTML',
          });
        } catch { /* non-critical */ }
      } else if (showThinking && thinkingText && !thinkingMsgId) {
        // Thinking finished before first interval tick — send it now
        try {
          await sendWithRetry(ctx, `<i>Thinking:</i>\n\n${escHtml(thinkingText.slice(0, 3000))}`, {
            parse_mode: 'HTML',
            reply_parameters:
              chatType === 'group' && ctx.message
                ? { message_id: ctx.message.message_id }
                : undefined,
          });
        } catch { /* non-critical */ }
      }

      if (result.text) {
        // Prefer structured media from tool results; fall back to text extraction
        const stateDir = this.config._stateDir || '';
        const workspace = this.config.agent.workspace;

        let mediaItems: MediaItem[];
        let cleanText: string;

        if (result.media && result.media.length > 0) {
          // Convert MediaAttachment[] → MediaItem[] for sendTelegramMedia
          mediaItems = result.media.map((a: MediaAttachment) => ({
            type: a.type,
            filePath: a.filePath,
            fileName: a.fileName,
            mimeType: a.mimeType,
            caption: a.caption,
            match: '',
          }));
          // Still strip markdown media refs from text for a clean caption
          ({ cleanText } = extractMedia(result.text, stateDir, workspace));
        } else {
          ({ items: mediaItems, cleanText } = extractMedia(result.text, stateDir, workspace));
        }

        if (mediaItems.length > 0) {
          const replyParams = chatType === 'group' && ctx.message
            ? { message_id: ctx.message.message_id }
            : undefined;
          const formattedCaption = markdownToTelegramHtml(cleanText);
          const caption = formattedCaption.slice(0, 1024) || undefined;
          let mediaSent = false;

          for (const item of mediaItems) {
            try {
              await this.sendTelegramMedia(ctx, item, caption && !mediaSent ? caption : undefined, replyParams);
              mediaSent = true;
            } catch (e: unknown) {
              const errMsg = e instanceof Error ? e.message : String(e);
              log.debug({ err: errMsg, type: item.type, file: item.fileName }, 'Failed to send media, will fall back to text');
            }
          }

          if (mediaSent) {
            if (formattedCaption.length > 1024) {
              const remainingText = formattedCaption.slice(1024);
              const chunks = splitMessage(remainingText, 4000);
              for (const chunk of chunks) {
                await sendWithRetry(ctx, chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
              }
            }
            return;
          }
        }

        // Append model indicator if enabled (display only, not stored in DB)
        let displayText = result.text;
        if (shouldShowModelIndicator(this.config.agent?.showModelIndicator?.telegram, result.userRole) && result.model) {
          displayText = appendModelIndicator(displayText, result.model);
        }

        // Convert standard Markdown to Telegram HTML
        displayText = markdownToTelegramHtml(displayText);

        // Split long messages (Telegram limit: 4096 chars)
        const chunks = splitMessage(displayText, 4000);
        for (const chunk of chunks) {
          await sendWithRetry(ctx, chunk, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_parameters:
              chatType === 'group' && ctx.message
                ? { message_id: ctx.message.message_id }
                : undefined,
          });
        }
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error({ err: errMsg }, 'Telegram handler error');
      try {
        await ctx.reply('Something went wrong. Please try again.');
      } catch {
        /* ignore */
      }
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  }

  // ── File download ──────────────────────────────────────

  private async downloadFile(fileId: string, filename: string, senderId?: string): Promise<string | null> {
    if (!this.bot) return null;
    try {
      // Save to sender's scoped media dir if linked, otherwise shared/media
      let mediaDir: string;
      if (senderId) {
        const { getScopedMediaDir } = await import('../media/scoped-dir.js');
        mediaDir = await getScopedMediaDir(this.config.agent.workspace, 'telegram', senderId, this.db, this.tenantId);
      } else {
        mediaDir = path.join(this.config.agent.workspace, 'shared', 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
      }

      const file = await this.bot.api.getFile(fileId);
      const filePath = file.file_path;
      if (!filePath) return null;

      const token = this.resolvedBotToken;
      const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return null;

      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = path.extname(filePath) || path.extname(filename || '') || '';
      const finalPath = ext
        ? path.join(mediaDir, `${Date.now()}${ext}`)
        : path.join(mediaDir, `${Date.now()}-${filename || 'file'}.bin`);

      await fs.promises.writeFile(finalPath, new Uint8Array(buffer));
      log.info({ path: finalPath, size: buffer.length }, 'Telegram file downloaded');
      return finalPath;
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error({ err: errMsg }, 'Failed to download Telegram file');
      return null;
    }
  }

  /**
   * Download a Telegram file and return its contents as a base64 string.
   * Returns null if the download fails.
   */
  private async downloadFileAsBase64(fileId: string): Promise<string | null> {
    if (!this.bot) return null;
    try {
      const file = await this.bot.api.getFile(fileId);
      const filePath = file.file_path;
      if (!filePath) return null;

      const token = this.resolvedBotToken;
      const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return null;

      const buffer = Buffer.from(await res.arrayBuffer());
      return buffer.toString('base64');
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error({ err: errMsg }, 'Failed to download Telegram file as base64');
      return null;
    }
  }

  /** Send a media item via the appropriate Telegram API method. */
  private async sendTelegramMedia(
    ctx: Context,
    item: MediaItem,
    caption?: string,
    replyParams?: { message_id: number },
  ): Promise<void> {
    const file = new InputFile(fs.createReadStream(item.filePath), item.fileName);
    const opts = {
      caption,
      parse_mode: caption ? 'HTML' as const : undefined,
      reply_parameters: replyParams,
    };

    switch (item.type) {
      case 'image':
        await ctx.replyWithPhoto(file, opts);
        break;
      case 'audio':
        await ctx.replyWithAudio(file, opts);
        break;
      case 'voice':
        await ctx.replyWithVoice(file, opts);
        break;
      case 'video':
        await ctx.replyWithVideo(file, opts);
        break;
      case 'document':
      default:
        await ctx.replyWithDocument(file, opts);
        break;
    }
  }

  /** Send a message to a specific Telegram chat. Used by send_message tool. */
  async sendToChat(text: string, chatId?: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not started');
    const targetChatId = chatId || this.lastActiveChatId;
    if (!targetChatId) throw new Error('No chat ID specified and no recent active chat');

    const sendWithBackoff = async (msg: string, opts: Record<string, unknown> = {}, retries = 3): Promise<void> => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          await this.bot!.api.sendMessage(targetChatId, msg, opts);
          return;
        } catch (e: unknown) {
          const err = e as { error_code?: number; message?: string; parameters?: { retry_after?: number } };
          if (err.error_code === 429 || err.message?.includes('Too Many Requests')) {
            const retryAfter = err.parameters?.retry_after || 2 ** attempt;
            log.warn({ retryAfter, attempt, chatId: targetChatId }, 'Telegram rate limit in sendToChat, retrying');
            await new Promise((r) => setTimeout(r, retryAfter * 1000));
            continue;
          }
          if (attempt === 0 && opts.parse_mode && /can't parse|parse entities|find end of the entity/i.test(err.message || '')) {
            const safeHtml = msg.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tag) =>
              TG_SAFE_TAGS.test(tag.toLowerCase()) ? match : '');
            try {
              await this.bot!.api.sendMessage(targetChatId, safeHtml, opts);
              return;
            } catch {
              const plain = msg.replace(/<[^>]+>/g, '');
              const { parse_mode: _, ...rest } = opts;
              return sendWithBackoff(plain, rest, retries - 1);
            }
          }
          throw e;
        }
      }
    };

    const formatted = markdownToTelegramHtml(text);
    const MAX_LEN = 4000;
    if (formatted.length <= MAX_LEN) {
      await sendWithBackoff(formatted, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } else {
      const chunks = splitMessage(formatted, MAX_LEN);
      for (const chunk of chunks) {
        await sendWithBackoff(chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch((e: unknown) => {
          log.warn({ err: e instanceof Error ? e.message : String(e), chatId: targetChatId }, 'Telegram chunk send failed');
        });
      }
    }
  }

  /** Return bot info (username, id) if available. */
  getBotInfo(): { username?: string; id?: number } | null {
    if (!this.bot) return null;
    try {
      const info = this.bot.botInfo;
      return { username: info.username, id: info.id };
    } catch {
      return null;
    }
  }

  /** Send media attachments with optional text to a Telegram chat. */
  async sendMediaToChat(media: MediaAttachment[], text: string, chatId?: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not started');
    const targetChatId = chatId || this.lastActiveChatId;
    if (!targetChatId) throw new Error('No chat ID specified and no recent active chat');

    const stateDir = this.config._stateDir || '';
    const workspace = this.config.agent.workspace;

    const items: MediaItem[] = [];
    for (const a of media) {
      if (fs.existsSync(a.filePath)) {
        items.push({ type: a.type, filePath: a.filePath, fileName: a.fileName, mimeType: a.mimeType, caption: a.caption, match: '' });
      } else {
        log.warn({ filePath: a.filePath, fileName: a.fileName }, 'Media attachment file not found at delivery time — skipping');
      }
    }

    if (items.length === 0) {
      const extracted = extractMedia(text, stateDir, workspace);
      items.push(...extracted.items);
    }

    if (items.length > 0) {
      const { cleanText } = extractMedia(text, stateDir, workspace);
      const formattedCaption = markdownToTelegramHtml(cleanText);
      const caption = formattedCaption.slice(0, 1024) || undefined;
      let mediaSent = false;
      for (const item of items) {
        const file = new InputFile(fs.createReadStream(item.filePath), item.fileName);
        const opts = { caption: !mediaSent ? caption : undefined, parse_mode: (!mediaSent && caption) ? 'HTML' as const : undefined };
        try {
          switch (item.type) {
            case 'image': {
              const fileSizeMB = fs.statSync(item.filePath).size / (1024 * 1024);
              if (fileSizeMB > 10) {
                await this.bot.api.sendDocument(targetChatId, file, opts);
              } else {
                await this.bot.api.sendPhoto(targetChatId, file, opts);
              }
              break;
            }
            case 'audio':
              await this.bot.api.sendAudio(targetChatId, file, opts);
              break;
            case 'voice':
              await this.bot.api.sendVoice(targetChatId, file, opts);
              break;
            case 'video':
              await this.bot.api.sendVideo(targetChatId, file, opts);
              break;
            default:
              await this.bot.api.sendDocument(targetChatId, file, opts);
              break;
          }
          mediaSent = true;
        } catch (e) {
          log.warn({ err: (e as Error).message, type: item.type, filePath: item.filePath }, 'Failed to send media in cron delivery');
        }
      }
      if (mediaSent) {
        if (cleanText.length > 1024) {
          await this.sendToChat(cleanText.slice(1024), targetChatId);
        }
        return;
      }
    }

    // Fallback to text
    await this.sendToChat(text, chatId);
  }

  private lastActiveChatId: string | null = null;
}

// ─── Factory ────────────────────────────────────────────────

/**
 * Create a Telegram channel instance.
 */
export interface TelegramChannelInstance extends Channel {
  sendToChat(text: string, chatId?: string): Promise<void>;
  sendMediaToChat(media: import('@agw/types').MediaAttachment[], text: string, chatId?: string): Promise<void>;
  getBotInfo(): { username?: string; id?: number } | null;
}

export function createTelegramChannel(
  config: GatewayConfig,
  db: DatabaseAdapter,
  tenantId: string,
  secretsStore?: SecretsStore,
): TelegramChannelInstance {
  return new TelegramChannel(config, db, tenantId, secretsStore);
}
