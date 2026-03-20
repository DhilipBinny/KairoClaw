/**
 * Email (SMTP) tool — send emails via configured SMTP server.
 *
 * Security:
 * - Disabled by default (admin must opt-in)
 * - `from` address locked by admin config (LLM cannot change it)
 * - Recipient restrictions via allowedDomains / allowedRecipients
 * - Max recipients per message capped
 * - Plain text only (no HTML — prevents LLM-generated phishing)
 * - Rate limited: per-minute, per-hour, per-day, per-recipient
 * - SMTP credentials stored in SecretsStore, never in config
 * - RBAC default: 'confirm' (human approval before send)
 *
 * Credentials: secretsStore.set('tools.email', 'user', ...) / 'pass'
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { ToolRegistration } from '../types.js';

// ─── Rate limiter ────────────────────────────────────────

interface RateWindow {
  timestamps: number[];
}

const rateLimiter = {
  global: { timestamps: [] } as RateWindow,
  perRecipient: new Map<string, RateWindow>(),
};

function isRateLimited(
  limits: { perMinute?: number; perHour?: number; perDay?: number; perRecipientPerHour?: number },
  recipient: string,
): string | null {
  const now = Date.now();
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;

  // Clean old entries
  rateLimiter.global.timestamps = rateLimiter.global.timestamps.filter(t => now - t < day);

  const perMinute = limits.perMinute ?? 5;
  const perHour = limits.perHour ?? 20;
  const perDay = limits.perDay ?? 50;
  const perRecipientPerHour = limits.perRecipientPerHour ?? 3;

  const inLastMinute = rateLimiter.global.timestamps.filter(t => now - t < minute).length;
  if (inLastMinute >= perMinute) return `Rate limit: max ${perMinute} emails per minute`;

  const inLastHour = rateLimiter.global.timestamps.filter(t => now - t < hour).length;
  if (inLastHour >= perHour) return `Rate limit: max ${perHour} emails per hour`;

  const inLastDay = rateLimiter.global.timestamps.length;
  if (inLastDay >= perDay) return `Rate limit: max ${perDay} emails per day`;

  // Per-recipient check
  const recipientWindow = rateLimiter.perRecipient.get(recipient);
  if (recipientWindow) {
    recipientWindow.timestamps = recipientWindow.timestamps.filter(t => now - t < hour);
    if (recipientWindow.timestamps.length >= perRecipientPerHour) {
      return `Rate limit: max ${perRecipientPerHour} emails per hour to ${recipient}`;
    }
  }

  return null;
}

function recordSend(recipients: string[]): void {
  const now = Date.now();
  rateLimiter.global.timestamps.push(now);
  for (const r of recipients) {
    if (!rateLimiter.perRecipient.has(r)) {
      rateLimiter.perRecipient.set(r, { timestamps: [] });
    }
    rateLimiter.perRecipient.get(r)!.timestamps.push(now);
  }
  // Evict per-recipient entries if map grows too large
  if (rateLimiter.perRecipient.size > 500) {
    const hour = 3_600_000;
    for (const [key, window] of rateLimiter.perRecipient) {
      window.timestamps = window.timestamps.filter(t => now - t < hour);
      if (window.timestamps.length === 0) rateLimiter.perRecipient.delete(key);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseRecipients(value: unknown): string[] {
  if (!value || typeof value !== 'string') return [];
  return value.split(',').map(s => s.trim()).filter(s => EMAIL_REGEX.test(s));
}

function validateRecipient(
  email: string,
  allowedDomains: string[],
  allowedRecipients: string[],
): string | null {
  if (!EMAIL_REGEX.test(email)) return `Invalid email: ${email}`;

  // If allowedRecipients is set, it takes priority (strictest)
  if (allowedRecipients.length > 0) {
    if (!allowedRecipients.includes(email.toLowerCase())) {
      return `Recipient not in allowed list: ${email}`;
    }
    return null;
  }

  // Domain check
  if (allowedDomains.length > 0) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain || !allowedDomains.includes(domain)) {
      return `Domain not allowed: ${domain}. Allowed: ${allowedDomains.join(', ')}`;
    }
  }

  return null;
}

// ─── Transporter cache ───────────────────────────────────

let cachedTransporter: Transporter | null = null;
let cachedConfigHash = '';

function getTransporter(smtpConfig: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}): Transporter {
  const hash = `${smtpConfig.host}:${smtpConfig.port}:${smtpConfig.user}`;
  if (cachedTransporter && cachedConfigHash === hash) {
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: {
      user: smtpConfig.user,
      pass: smtpConfig.pass,
    },
    tls: { rejectUnauthorized: true },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  cachedConfigHash = hash;
  return cachedTransporter;
}

// ─── Tool definition ─────────────────────────────────────

export const emailTools: ToolRegistration[] = [
  {
    definition: {
      name: 'send_email',
      description:
        'Send an email via SMTP. The "from" address is set by admin config and cannot be changed. ' +
        'Only plain text is supported. Recipient must be a valid email address.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject line (max 200 chars)' },
          body: { type: 'string', description: 'Email body in plain text (max 10000 chars)' },
          cc: { type: 'string', description: 'CC recipients, comma-separated (optional)' },
          bcc: { type: 'string', description: 'BCC recipients, comma-separated (optional)' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    executor: async (args, context) => {
      const ctx = context as Record<string, unknown>;
      const config = ctx.config as Record<string, Record<string, Record<string, unknown>>>;
      const emailConfig = config?.tools?.email as Record<string, unknown> | undefined;

      if (!emailConfig?.enabled) {
        return { error: 'Email tool is not enabled. Configure SMTP in Settings.' };
      }

      // Read SMTP credentials from secrets store
      const secretsStore = ctx.secretsStore as { get: (ns: string, key: string) => string | undefined } | undefined;
      const smtpUser = secretsStore?.get('tools.email', 'user') || '';
      const smtpPass = secretsStore?.get('tools.email', 'pass') || '';
      const smtpHost = (emailConfig.host as string) || '';
      const smtpPort = (emailConfig.port as number) || 587;
      const smtpSecure = (emailConfig.secure as boolean) || false;
      const fromAddress = (emailConfig.from as string) || '';

      if (!smtpHost) return { error: 'SMTP host not configured' };
      if (!fromAddress) return { error: 'From address not configured' };
      if (!smtpUser || !smtpPass) return { error: 'SMTP credentials not configured' };

      // Validate & parse args
      const to = (args.to as string || '').trim();
      let subject = (args.subject as string || '').trim();
      let body = (args.body as string || '').trim();

      if (!to) return { error: 'Recipient (to) is required' };
      if (!subject) return { error: 'Subject is required' };
      if (!body) return { error: 'Body is required' };

      // Enforce limits
      if (subject.length > 200) subject = subject.slice(0, 200);
      if (body.length > 10_000) body = body.slice(0, 10_000);

      // Parse all recipients
      const toList = parseRecipients(to);
      const ccList = parseRecipients(args.cc);
      const bccList = parseRecipients(args.bcc);
      const allRecipients = [...toList, ...ccList, ...bccList];

      if (toList.length === 0) return { error: `Invalid recipient email: ${to}` };

      // Max recipients
      const maxRecipients = (emailConfig.maxRecipientsPerMessage as number) || 5;
      if (allRecipients.length > maxRecipients) {
        return { error: `Too many recipients (${allRecipients.length}). Max ${maxRecipients} per message.` };
      }

      // Validate each recipient against allowlist
      const allowedDomains = (emailConfig.allowedDomains as string[]) || [];
      const allowedRecipients = (emailConfig.allowedRecipients as string[]) || [];
      for (const r of allRecipients) {
        const err = validateRecipient(r, allowedDomains, allowedRecipients);
        if (err) return { error: err };
      }

      // Rate limit check
      const rateLimits = (emailConfig.rateLimit as Record<string, number>) || {};
      for (const r of allRecipients) {
        const limited = isRateLimited(rateLimits, r);
        if (limited) return { error: limited };
      }

      // Build transporter and send
      try {
        const transporter = getTransporter({
          host: smtpHost,
          port: smtpPort,
          secure: smtpSecure,
          user: smtpUser,
          pass: smtpPass,
        });

        const info = await transporter.sendMail({
          from: fromAddress,
          to: toList.join(', '),
          cc: ccList.length > 0 ? ccList.join(', ') : undefined,
          bcc: bccList.length > 0 ? bccList.join(', ') : undefined,
          subject,
          text: body,
        });

        // Record for rate limiting
        recordSend(allRecipients);

        return {
          success: true,
          messageId: info.messageId,
          to: toList,
          subject,
        };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);

        // Categorize errors
        if (message.includes('EAUTH') || message.includes('authentication')) {
          return { error: 'SMTP authentication failed. Check credentials in Settings.' };
        }
        if (message.includes('ECONNECTION') || message.includes('ETIMEDOUT')) {
          return { error: `SMTP connection failed: ${message}. Check host/port settings.` };
        }
        return { error: `Email send failed: ${message}` };
      }
    },
    source: 'builtin',
    category: 'execute',
  },
];
