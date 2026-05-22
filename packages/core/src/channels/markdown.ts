/**
 * Channel-specific Markdown renderers using `marked`.
 *
 * Parses standard Markdown (from LLM output), then renders
 * to channel-native formatting via custom renderer overrides.
 *
 * - Telegram: HTML (parse_mode: 'HTML')
 * - WhatsApp: Native formatting (*bold* _italic_ ~strike~ ```code```)
 * - WebChat: Raw markdown (client-side rendering, no conversion needed)
 */

import { Marked } from 'marked';

function escHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Common renderer overrides shared between Telegram and WhatsApp
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
    heading({ text }: any) { return `\n${b(text)}\n\n`; },
    paragraph({ text }: any) { return `${text}\n\n`; },
    strong({ text }: any) { return b(text); },
    em({ text }: any) { return i(text); },
    del({ text }: any) { return s(text); },
    codespan({ text }: any) { return cs(text); },
    code({ text, lang }: any) {
      if (fmt === 'telegram') {
        return lang
          ? `<pre><code class="language-${escHtml(lang)}">${escHtml(text)}</code></pre>\n`
          : `<pre>${escHtml(text)}</pre>\n`;
      }
      return `\`\`\`\n${text}\n\`\`\`\n`;
    },
    link({ href, text }: any) { return lnk(href, text); },
    image({ text }: any) { return text ? `[${text}]` : ''; },
    blockquote({ text }: any) { return bq(text); },
    list(token: any) { return `${token.body || token.items?.map((i: any) => `• ${i.text || ''}\n`).join('') || ''}\n`; },
    listitem({ text }: any) { return `• ${(text || '').trim()}\n`; },
    hr() { return '\n'; },
    table(token: any) { return `${token.header || ''}${token.body || ''}\n`; },
    tablerow({ text }: any) { return `${text}\n`; },
    tablecell({ text }: any) { return `${text} | `; },
    br() { return '\n'; },
  };
}

const telegramMarked = new Marked({ async: false, breaks: true, renderer: makeRenderer('telegram') });
const whatsappMarked = new Marked({ async: false, breaks: true, renderer: makeRenderer('whatsapp') });

/**
 * Convert standard Markdown to Telegram HTML format.
 * Use with parse_mode: 'HTML' in Grammy/Bot API calls.
 */
export function markdownToTelegramHtml(text: string): string {
  if (!text) return text;
  try {
    return (telegramMarked.parse(text) as string).trim();
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
    return (whatsappMarked.parse(text) as string).trim();
  } catch {
    return text;
  }
}
