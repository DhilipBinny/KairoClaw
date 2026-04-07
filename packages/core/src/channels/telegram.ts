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
import { createModuleLogger } from '../observability/logger.js';
import { sanitizeInput, detectPromptInjection } from '../security/input.js';

const log = createModuleLogger('channel.telegram');

// ─── Helpers ────────────────────────────────────────────────

/**
 * Send a message with retry and exponential backoff for Telegram rate limits.
 */
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
      // If parse_mode caused a failure on first attempt, retry without it
      if (attempt === 0 && options.parse_mode && err.message?.includes("can't parse")) {
        const { parse_mode: _, ...rest } = options;
        return sendWithRetry(ctx, text, rest, maxRetries - 1);
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

  constructor(config: GatewayConfig, db: DatabaseAdapter, tenantId: string, secretsStore?: SecretsStore) {
    this.config = config;
    this.db = db;
    this.tenantId = tenantId;
    this.secretsStore = secretsStore;
    this.pendingSenders = new PendingSenderRepository(db);
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
        '*Commands*\n\n' +
        '/start — Welcome message\n' +
        '/new — Start fresh session (clears history)\n' +
        '/status — Show session info\n' +
        '/compact — Compress long conversations\n' +
        '/model — Show or switch AI model\n' +
        '/help — Show this list\n' +
        '/myid — Show your Telegram user ID\n\n' +
        'Or just send any message to chat.',
        { parse_mode: 'Markdown' },
      );
    });

    this.bot.command('myid', async (ctx) => {
      if (!ctx.from) return;
      const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
      await ctx.reply(
        `Your Telegram user ID: \`${ctx.from.id}\`\n` +
        (name ? `Name: ${name}\n` : '') +
        `\nPaste this ID into *Allowed Users* on the admin Channels page to grant access.`,
        { parse_mode: 'Markdown' },
      );
    });

    this.bot.command('groupid', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') {
        await ctx.reply('This command only works in groups.');
        return;
      }
      const title = ctx.chat.title || 'this group';
      await ctx.reply(
        `Group ID: \`${ctx.chat.id}\`\nName: ${title}\n\n` +
        `Paste this ID into *Allowed Groups* on the admin Channels page to grant access.`,
        { parse_mode: 'Markdown' },
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
        const text = caption || "What's in this image?";
        await this.handleMessage(ctx, text, [{ data: imageData, mimeType: 'image/jpeg' }]);
      } else {
        // Fallback: save to disk
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
    const senderName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Unknown';
    if (cfg.allowFrom?.length > 0) {
      const allowed = cfg.allowFrom.map(String);
      if (!allowed.includes(senderId)) {
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
      const hasGroupAllowlist = cfg.groupAllowFrom?.length > 0;
      try {
        const status = hasGroupAllowlist ? 'pending' : 'seen';
        const cap = status === 'seen' ? PENDING_SEEN_CAP : PENDING_PENDING_CAP;
        await this.pendingSenders.recordWithResolutionCheck('telegram', chatId, groupName, status, cap);
      } catch { /* non-critical */ }

      // Group allowlist (if set, only listed group IDs are allowed)
      if (hasGroupAllowlist) {
        if (!cfg.groupAllowFrom.map(String).includes(chatId)) {
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
      if (cfg.groupRequireAllowFrom && cfg.allowFrom?.length > 0) {
        const allowed = cfg.allowFrom.map(String);
        if (!allowed.includes(senderId)) {
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
    const msgText = sanitizeInput(rawText);
    const injection = detectPromptInjection(msgText);
    if (injection.suspicious) {
      log.warn({ patterns: injection.patterns, senderId }, 'Prompt injection patterns detected (telegram)');
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
          const display = `_Thinking..._\n\n${thinkingText.slice(-3000)}`;
          try {
            if (!thinkingMsgId) {
              const sent = await ctx.reply(display, {
                parse_mode: 'Markdown',
                reply_parameters:
                  chatType === 'group' && ctx.message
                    ? { message_id: ctx.message.message_id }
                    : undefined,
              });
              thinkingMsgId = sent.message_id;
            } else {
              await ctx.api.editMessageText(ctx.chat!.id, thinkingMsgId, display, {
                parse_mode: 'Markdown',
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
        const finalThinking = `_Thinking:_\n\n${thinkingText.slice(-3000)}`;
        try {
          await ctx.api.editMessageText(ctx.chat!.id, thinkingMsgId, finalThinking, {
            parse_mode: 'Markdown',
          });
        } catch { /* non-critical */ }
      } else if (showThinking && thinkingText && !thinkingMsgId) {
        // Thinking finished before first interval tick — send it now
        try {
          await sendWithRetry(ctx, `_Thinking:_\n\n${thinkingText.slice(0, 3000)}`, {
            parse_mode: 'Markdown',
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
          const caption = cleanText.slice(0, 1024) || undefined;
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
            // If there's remaining text beyond the caption, send it as a separate message
            if (cleanText.length > 1024) {
              const remainingText = cleanText.slice(1024);
              const chunks = splitMessage(remainingText, 4000);
              for (const chunk of chunks) {
                await sendWithRetry(ctx, chunk, { parse_mode: 'Markdown' });
              }
            }
            return;
          }
          // If no media was sent successfully, fall through to text
        }

        // Append model indicator if enabled (display only, not stored in DB)
        let displayText = result.text;
        if (shouldShowModelIndicator(this.config.agent?.showModelIndicator?.telegram, result.userRole) && result.model) {
          displayText = appendModelIndicator(displayText, result.model);
        }

        // Split long messages (Telegram limit: 4096 chars)
        const chunks = splitMessage(displayText, 4000);
        for (const chunk of chunks) {
          await sendWithRetry(ctx, chunk, {
            parse_mode: 'Markdown',
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
    const file = new InputFile(fs.createReadStream(item.filePath));
    const opts = {
      caption,
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

    // Split long messages (Telegram limit: 4096 chars)
    const MAX_LEN = 4000;
    if (text.length <= MAX_LEN) {
      await this.bot.api.sendMessage(targetChatId, text, { parse_mode: 'Markdown' }).catch(() => {
        // Retry without Markdown if parsing fails
        return this.bot!.api.sendMessage(targetChatId, text);
      });
    } else {
      const chunks = [];
      for (let i = 0; i < text.length; i += MAX_LEN) {
        chunks.push(text.slice(i, i + MAX_LEN));
      }
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(targetChatId, chunk).catch((e: unknown) => {
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

    const items: MediaItem[] = media
      .filter(a => fs.existsSync(a.filePath))
      .map(a => ({ type: a.type, filePath: a.filePath, fileName: a.fileName, mimeType: a.mimeType, caption: a.caption, match: '' }));

    if (items.length === 0) {
      const extracted = extractMedia(text, stateDir, workspace);
      items.push(...extracted.items);
    }

    if (items.length > 0) {
      const { cleanText } = extractMedia(text, stateDir, workspace);
      const caption = cleanText.slice(0, 1024) || undefined;
      let mediaSent = false;
      for (const item of items) {
        const file = new InputFile(fs.createReadStream(item.filePath));
        const opts = { caption: !mediaSent ? caption : undefined };
        try {
          switch (item.type) {
            case 'image':
              await this.bot.api.sendPhoto(targetChatId, file, opts);
              break;
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
          log.debug({ err: (e as Error).message, type: item.type }, 'Failed to send media in cron delivery');
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
