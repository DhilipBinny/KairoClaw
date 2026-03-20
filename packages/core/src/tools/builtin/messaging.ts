import type { ToolRegistration } from '../types.js';

export const messagingTools: ToolRegistration[] = [
  {
    definition: {
      name: 'send_message',
      description: 'Proactively send a message to a channel (web, telegram, or whatsapp). Use this to alert or notify the user.\n\nFor the CURRENT chat: omit chatId — the system auto-fills it from the session. Do NOT ask the user for their phone number or chat ID.\nOnly provide chatId when sending to a DIFFERENT chat than the current one.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel to send to: "web", "telegram", or "whatsapp"' },
          text: { type: 'string', description: 'Message text to send' },
          chatId: { type: 'string', description: 'Optional. For telegram: chat ID. For whatsapp: JID. Leave empty to send to the current chat.' },
        },
        required: ['text', 'channel'],
      },
    },
    executor: async (args, context) => {
      const text = args.text as string;
      if (!text) return { error: 'text is required' };
      const channel = (args.channel as string) || 'web';
      const ctx = context as Record<string, unknown>;

      // Auto-fill chatId from session context when not provided
      let chatId = args.chatId as string | undefined;
      if (!chatId) {
        const session = (ctx.session as Record<string, unknown>) || {};
        const sessionChannel = session.channel as string || '';
        const sessionChatId = session.chat_id as string || '';
        if (channel === 'whatsapp' && sessionChannel === 'whatsapp' && sessionChatId) {
          chatId = sessionChatId.replace(/^whatsapp:/, '');
        } else if (channel === 'telegram' && sessionChannel === 'telegram' && sessionChatId) {
          chatId = sessionChatId.replace(/^telegram:/, '');
        }
      }

      if (channel === 'web') {
        // Use the broadcast function injected via context
        const broadcast = ctx.broadcastToWeb as ((msg: Record<string, unknown>) => void) | undefined;
        if (broadcast) {
          broadcast({
            type: 'chat.proactive',
            text,
            ts: new Date().toISOString(),
          });
          return { success: true, channel: 'web', delivered: true };
        }
        return { error: 'WebChat broadcast not available' };
      }

      if (channel === 'telegram') {
        const telegramSend = ctx.telegramSend as ((text: string, chatId?: string) => Promise<void>) | undefined;
        if (telegramSend) {
          try {
            await telegramSend(text, chatId);
            return { success: true, channel: 'telegram', delivered: true };
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            return { error: `Telegram send failed: ${message}` };
          }
        }
        return { error: 'Telegram not available' };
      }

      if (channel === 'whatsapp') {
        const whatsappSend = ctx.whatsappSend as ((text: string, jid?: string) => Promise<void>) | undefined;
        if (whatsappSend) {
          try {
            await whatsappSend(text, chatId);
            return { success: true, channel: 'whatsapp', delivered: true };
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            return { error: `WhatsApp send failed: ${message}` };
          }
        }
        return { error: 'WhatsApp not available' };
      }

      return { error: `Unknown channel: ${channel}` };
    },
    source: 'builtin',
    category: 'write',
  },
  {
    definition: {
      name: 'session_status',
      description: 'Show current session status including usage stats, model, and uptime.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    executor: async (_args, context) => {
      const session = context.session || {} as Record<string, unknown>;
      const ctx = context as Record<string, unknown>;
      return {
        sessionKey: session.key || 'unknown',
        sessionId: session.sessionId || 'unknown',
        model: (ctx.primaryModel as string) || 'unknown',
        inputTokens: session.inputTokens || 0,
        outputTokens: session.outputTokens || 0,
        turns: session.turns || 0,
        uptime: process.uptime().toFixed(0) + 's',
        time: new Date().toISOString(),
      };
    },
    source: 'builtin',
    category: 'read',
  },
  {
    definition: {
      name: 'manage_cron',
      description: `Manage scheduled cron jobs. Create, list, update, or delete recurring tasks.
Jobs run on a cron schedule. When delivery.mode is "announce", the AI generates text and the system delivers it to the configured channels automatically.

Schedule examples:
- Daily at 9 AM SGT: schedule.type="cron", schedule.value="0 9 * * *", schedule.tz="Asia/Singapore"
- Every 3 hours daytime: schedule.value="0 7,10,13,16,19,22 * * *"
- One-shot: schedule.type="at", schedule.value="<ISO timestamp>"
- Every 5 min: schedule.type="every", schedule.value=300000

Delivery: use delivery.targets array for per-channel routing. Each target needs a channel and optionally a "to" address.
- Telegram: { channel: "telegram", to: "<chat_id>" } or { channel: "telegram" } for current chat
- WhatsApp: { channel: "whatsapp", to: "<phone>@s.whatsapp.net" } or { channel: "whatsapp" } for current chat
- Web: { channel: "web" } (no "to" needed)
- Multi-channel: include multiple targets in the array.

IMPORTANT delivery rules:
- For "this chat" / "same chat" / current conversation: leave "to" EMPTY or omit it entirely. The system auto-fills the correct address from the current session. Do NOT guess or fabricate phone numbers or chat IDs.
- Only provide an explicit "to" when the user specifies a DIFFERENT chat/number than the current one.
- WhatsApp "to" must be in JID format: "<phone>@s.whatsapp.net" (e.g. "6591234567@s.whatsapp.net").`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'run'], description: 'Action to perform. "run" immediately executes the job AND delivers the result to the saved delivery targets — do NOT use send_message separately after run.' },
          id: { type: 'string', description: 'Job ID (for update/remove/run)' },
          name: { type: 'string', description: 'Human-readable job name' },
          schedule: {
            type: 'object',
            description: 'Schedule config',
            properties: {
              type: { type: 'string', enum: ['cron', 'at', 'every'] },
              value: { type: 'string', description: 'Cron expression, ISO timestamp, or interval in ms' },
              tz: { type: 'string', description: 'IANA timezone (e.g., "Asia/Singapore"). Default: UTC' },
            },
          },
          prompt: { type: 'string', description: 'The prompt the AI will process when the job fires. Write it as a generation instruction — the system handles delivery.' },
          delivery: {
            type: 'object',
            description: 'Delivery config: { mode: "announce"|"none", targets: [{ channel, to }] }',
            properties: {
              mode: { type: 'string', enum: ['announce', 'none'] },
              targets: {
                type: 'array',
                description: 'Per-channel delivery targets',
                items: {
                  type: 'object',
                  properties: {
                    channel: { type: 'string', enum: ['telegram', 'whatsapp', 'web'] },
                    to: { type: 'string', description: 'Telegram chat ID or WhatsApp JID (phone@s.whatsapp.net)' },
                  },
                },
              },
            },
          },
          enabled: { type: 'boolean', description: 'Enable or disable the job' },
        },
        required: ['action'],
      },
    },
    executor: async (args, context) => {
      const action = args.action as string;
      if (!action) return { error: 'action is required' };

      // Cron scheduler is injected via context
      const ctx = context as Record<string, unknown>;
      const cronScheduler = ctx.cronScheduler as {
        list: () => Array<Record<string, unknown>>;
        add: (job: Record<string, unknown>) => Record<string, unknown>;
        update: (id: string, updates: Record<string, unknown>) => Record<string, unknown> | null;
        remove: (id: string) => boolean;
        run: (id: string) => Promise<Record<string, unknown>>;
      } | undefined;

      if (!cronScheduler) {
        return { error: 'Cron scheduler not available' };
      }

      switch (action) {
        case 'list': {
          const jobs = cronScheduler.list();
          return {
            count: jobs.length,
            jobs: jobs.map(j => ({
              id: j.id,
              name: j.name,
              schedule: j.schedule,
              prompt: ((j.prompt as string) || '').slice(0, 100) + ((j.prompt as string)?.length > 100 ? '...' : ''),
              delivery: j.delivery,
              enabled: j.enabled,
              lastRun: j.lastRun,
              lastResult: j.lastResult ? (j.lastResult as string).slice(0, 100) : null,
              runCount: j.runCount,
            })),
          };
        }
        case 'add': {
          if (!args.schedule) return { error: 'schedule is required for add' };
          if (!args.prompt || !(args.prompt as string).trim()) return { error: 'prompt is required for add' };

          // Auto-fill and validate delivery targets from conversation context
          let delivery = args.delivery as Record<string, unknown> | string | undefined;
          const session = (ctx.session as Record<string, unknown>) || {};
          const sessionChannel = session.channel as string || '';
          const sessionChatId = session.chat_id as string || '';

          if (delivery && typeof delivery === 'object' && delivery.mode === 'announce') {
            let targets = (delivery.targets || []) as Array<{ channel: string; to?: string }>;

            // Migrate legacy channel/to to targets format
            if (targets.length === 0 && delivery.channel) {
              const chs = Array.isArray(delivery.channel) ? delivery.channel as string[] : [delivery.channel as string];
              targets = chs.map(ch => ({ channel: ch, to: delivery!.to as string | undefined }));
            }

            // Auto-fill: if no targets at all, use current conversation channel
            if (targets.length === 0 && sessionChannel && sessionChannel !== 'cron') {
              targets = [{ channel: sessionChannel }];
            }

            // Auto-fill 'to' for each target using session context.
            // Fill when: missing, empty, or a sentinel like "_current"/"current"/"same".
            // Also fill when the LLM provided a bare phone number without @s.whatsapp.net
            // (likely hallucinated — override with actual session JID).
            for (const target of targets) {
              const needsAutoFill = !target.to
                || target.to === '_current' || target.to === 'current' || target.to === 'same'
                || (target.channel === 'whatsapp' && target.to && !target.to.includes('@'))
                || (target.channel === 'whatsapp' && target.to && target.to.includes('@lid'));

              if (needsAutoFill && sessionChatId) {
                if (target.channel === 'whatsapp' && sessionChannel === 'whatsapp') {
                  target.to = sessionChatId.replace(/^whatsapp:/, '');
                } else if (target.channel === 'telegram' && sessionChannel === 'telegram') {
                  target.to = sessionChatId.replace(/^telegram:/, '');
                }
              }
            }

            // Validate: announce mode requires at least one target
            if (targets.length === 0) {
              return { error: 'delivery.mode is "announce" but no targets configured. Add targets: [{ channel: "whatsapp" }] to deliver to current chat.' };
            }
            // Validate: telegram/whatsapp targets must have 'to'
            for (const target of targets) {
              if ((target.channel === 'whatsapp' || target.channel === 'telegram') && !target.to) {
                return { error: `delivery target "${target.channel}" requires a "to" address but could not auto-fill from current session (session channel: ${sessionChannel}). Provide an explicit address or create this cron from the target channel.` };
              }
              // Validate WhatsApp JID format
              if (target.channel === 'whatsapp' && target.to && !target.to.includes('@')) {
                return { error: `Invalid WhatsApp "to": "${target.to}". Must be in JID format: "<phone>@s.whatsapp.net".` };
              }
            }

            // Store in normalized targets format
            delivery.targets = targets;
            // Clean up legacy fields
            delete delivery.channel;
            delete delivery.to;
          }

          const job = cronScheduler.add({
            name: args.name,
            schedule: args.schedule,
            prompt: args.prompt,
            delivery: delivery || 'none',
            enabled: args.enabled !== false,
          });
          return {
            success: true,
            job: { id: job.id, name: job.name, schedule: job.schedule, delivery: job.delivery },
            context: { sessionChannel, sessionChatId: sessionChatId || null },
          };
        }
        case 'update': {
          if (!args.id) return { error: 'id is required for update' };
          const updates: Record<string, unknown> = {};
          if (args.name !== undefined) updates.name = args.name;
          if (args.schedule !== undefined) updates.schedule = args.schedule;
          if (args.prompt !== undefined) updates.prompt = args.prompt;
          if (args.delivery !== undefined) updates.delivery = args.delivery;
          if (args.enabled !== undefined) updates.enabled = args.enabled;
          const updated = cronScheduler.update(args.id as string, updates);
          if (!updated) return { error: `Job not found: ${args.id}` };
          return { success: true, job: { id: updated.id, name: updated.name, schedule: updated.schedule, enabled: updated.enabled } };
        }
        case 'remove': {
          if (!args.id) return { error: 'id is required for remove' };
          const removed = cronScheduler.remove(args.id as string);
          return removed ? { success: true } : { error: `Job not found: ${args.id}` };
        }
        case 'run': {
          if (!args.id) return { error: 'id is required for run' };
          const result = await cronScheduler.run(args.id as string);
          return result;
        }
        default:
          return { error: `Unknown action: ${action}. Use: list, add, update, remove, run` };
      }
    },
    source: 'builtin',
    category: 'execute',
  },
];
