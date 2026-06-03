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

function escHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    // Block-level: use tokens + parser for child content
    heading(this: any, { tokens }: any) { return `\n${b(this.parser.parseInline(tokens))}\n\n`; },
    paragraph(this: any, { tokens }: any) { return `${this.parser.parseInline(tokens)}\n\n`; },
    blockquote(this: any, { tokens }: any) { return bq(this.parser.parse(tokens)); },
    listitem(this: any, { tokens }: any) { return `• ${this.parser.parse(tokens).trim()}\n`; },
    tablecell(this: any, { tokens }: any) { return `${this.parser.parseInline(tokens)} | `; },

    // Inline with children: use tokens + parser
    strong(this: any, { tokens }: any) { return b(this.parser.parseInline(tokens)); },
    em(this: any, { tokens }: any) { return i(this.parser.parseInline(tokens)); },
    del(this: any, { tokens }: any) { return s(this.parser.parseInline(tokens)); },
    link(this: any, { href, tokens }: any) { return lnk(href, this.parser.parseInline(tokens)); },

    // Leaf tokens: use text directly (no children)
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

    // Structural tokens — return false to use default (marked aggregates listitem results)
    list() { return false as any; },
    hr() { return '\n'; },
    table(this: any, token: any) {
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

/**
 * Convert standard Markdown to Telegram HTML format.
 * Use with parse_mode: 'HTML' in Grammy/Bot API calls.
 */
// Telegram only supports: b, i, u, s, code, pre, a, blockquote, tg-spoiler
const TG_ALLOWED_TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler']);
/** Pre-compiled regex for stripping unsupported HTML tags — hoisted to avoid recompilation per call. */
const UNSUPPORTED_TAG_RE = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;

export function markdownToTelegramHtml(text: string): string {
  if (!text) return text;
  try {
    let result = (telegramMarked.parse(text) as string).trim();
    // Strip unsupported HTML tags (ul, ol, li, p, etc.) — Telegram rejects them
    UNSUPPORTED_TAG_RE.lastIndex = 0;
    result = result.replace(UNSUPPORTED_TAG_RE, (match, tag) => {
      return TG_ALLOWED_TAGS.has(tag.toLowerCase()) ? match : '';
    });
    // Collapse excessive blank lines
    result = result.replace(/\n{3,}/g, '\n\n');
    return result;
  } catch {
    return text;
  }
}

/**
 * Convert standard Markdown to WhatsApp native formatting.
 * WhatsApp uses: *bold*  _italic_  ~strike~  ```code```
 */
export function markdownToWhatsAppFmt(text: string): string {
  if (!text) return text;
  try {
    let result = (whatsappMarked.parse(text) as string).trim();
    // Strip HTML list wrappers from default list renderer
    result = result.replace(/<\/?(?:ul|ol|li)>/g, '');
    // Decode HTML entities — marked escapes them but WhatsApp needs plain text
    result = result.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return result;
  } catch {
    return text;
  }
}
