/**
 * Channel-specific Markdown renderers using `marked`.
 *
 * Parses standard Markdown (from LLM output), then renders
 * to channel-native formatting via custom renderer overrides.
 *
 * Key rule for marked v17: block-level and inline renderers that contain
 * child content MUST use `{ tokens }` + `this.parser.parseInline(tokens)`
 * (or `this.parser.parse(tokens)` for block children). Using `{ text }`
 * returns raw markdown and skips inline rendering entirely.
 */

import { Marked } from 'marked';

export function escHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

function decodeHtmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * Clean common LLM double-encoding artifacts before parsing.
 * LLMs sometimes produce `&amp;quot;` (double-encoded) or pre-escaped HTML tags.
 */
function cleanLlmArtifacts(text: string): string {
  let md = text;
  md = md.replace(/&amp;quot;/g, '"').replace(/&amp;amp;/g, '&').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  return md;
}

function makeRenderer(fmt: 'telegram' | 'whatsapp') {
  const b = (t: string) => fmt === 'telegram' ? `<b>${t}</b>` : `*${t}*`;
  const i = (t: string) => fmt === 'telegram' ? `<i>${t}</i>` : `_${t}_`;
  const s = (t: string) => fmt === 'telegram' ? `<s>${t}</s>` : `~${t}~`;
  const cs = (t: string) => fmt === 'telegram' ? `<code>${escHtml(t)}</code>` : `\`${t}\``;
  const lnk = (href: string, text: string) =>
    fmt === 'telegram' ? `<a href="${escHtml(href)}">${text}</a>` : (text === href ? href : `${text} (${href})`);
  const bq = (t: string) =>
    fmt === 'telegram' ? `<blockquote>${t.trim()}</blockquote>\n` : t.split('\n').map((l: string) => `> ${l}`).join('\n') + '\n';

  return {
    heading(this: any, { tokens }: any) { return `\n${b(this.parser.parseInline(tokens))}\n\n`; },
    paragraph(this: any, { tokens }: any) { return `${this.parser.parseInline(tokens)}\n\n`; },
    blockquote(this: any, { tokens }: any) { return bq(this.parser.parse(tokens)); },
    listitem(this: any, { tokens, task, checked }: any) {
      const prefix = task ? (checked ? '☑ ' : '☐ ') : '• ';
      return `${prefix}${this.parser.parse(tokens).trim()}\n`;
    },
    tablecell(this: any, { tokens }: any) { return `${this.parser.parseInline(tokens)} | `; },

    strong(this: any, { tokens }: any) { return b(this.parser.parseInline(tokens)); },
    em(this: any, { tokens }: any) { return i(this.parser.parseInline(tokens)); },
    del(this: any, { tokens }: any) { return s(this.parser.parseInline(tokens)); },
    link(this: any, { href, tokens }: any) { return lnk(href, this.parser.parseInline(tokens)); },

    codespan({ text }: any) { return cs(text); },
    code({ text, lang }: any) {
      if (fmt === 'telegram') {
        return lang
          ? `<pre><code class="language-${escHtml(lang)}">${escHtml(text)}</code></pre>\n`
          : `<pre>${escHtml(text)}</pre>\n`;
      }
      return `\`\`\`\n${text}\n\`\`\`\n`;
    },
    image({ text }: any) { return text ? `[${text}]` : ''; },

    list() { return false as any; },
    hr() { return fmt === 'telegram' ? '━━━━━━━━━━━━\n' : '---\n'; },
    table(this: any, token: any) {
      if (fmt === 'telegram') {
        const hdr = token.header.map((c: any) => stripHtmlTags(this.parser.parseInline(c.tokens)));
        const rows = token.rows.map((row: any) => row.map((c: any) => stripHtmlTags(this.parser.parseInline(c.tokens))));
        const all = [hdr, ...rows];
        const widths = hdr.map((_: string, ci: number) => Math.max(...all.map((r: string[]) => (r[ci] || '').length)));
        const fmtRow = (r: string[]) => r.map((cell, ci) => cell.padEnd(widths[ci] || 0)).join(' │ ');
        const sep = widths.map((w: number) => '─'.repeat(w)).join('─┼─');
        return `<pre>${escHtml([fmtRow(hdr), sep, ...rows.map(fmtRow)].join('\n'))}</pre>\n`;
      }
      const headerCells = token.header.map((cell: any) => this.parser.parseInline(cell.tokens));
      let result = headerCells.join(' | ') + '\n';
      for (const row of token.rows) {
        const cells = row.map((cell: any) => this.parser.parseInline(cell.tokens));
        result += cells.join(' | ') + '\n';
      }
      return result + '\n';
    },
    br() { return '\n'; },
  };
}

const telegramMarked = new Marked({ async: false, breaks: true, renderer: makeRenderer('telegram') });
const whatsappMarked = new Marked({ async: false, breaks: true, renderer: makeRenderer('whatsapp') });

// Telegram only supports: b, i, u, s, code, pre, a, blockquote, tg-spoiler
const TG_ALLOWED_TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler']);
const UNSUPPORTED_TAG_RE = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;

export function markdownToTelegramHtml(text: string): string {
  if (!text) return text;
  try {
    const cleaned = cleanLlmArtifacts(text);
    let result = (telegramMarked.parse(cleaned) as string).trim();
    UNSUPPORTED_TAG_RE.lastIndex = 0;
    result = result.replace(UNSUPPORTED_TAG_RE, (match, tag) => {
      return TG_ALLOWED_TAGS.has(tag.toLowerCase()) ? match : '';
    });
    result = result.replace(/\n{3,}/g, '\n\n');
    return result;
  } catch {
    return text;
  }
}

export function markdownToWhatsAppFmt(text: string): string {
  if (!text) return text;
  try {
    const cleaned = cleanLlmArtifacts(text);
    let result = (whatsappMarked.parse(cleaned) as string).trim();
    result = result.replace(/<\/?(?:ul|ol|li)>/g, '');
    result = decodeHtmlEntities(result);
    return result;
  } catch {
    return text;
  }
}
