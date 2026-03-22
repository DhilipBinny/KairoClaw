/**
 * Shared utilities for channel implementations.
 */

// ── Markdown → WhatsApp formatting ───────────────────────

/**
 * Convert standard Markdown to WhatsApp-compatible formatting.
 *
 * WhatsApp uses:  *bold*  _italic_  ~strike~  ```code```
 * Markdown uses:  **bold**  *italic*  ~~strike~~  `code`
 *
 * Protects fenced code blocks and inline code spans from conversion.
 */
export function markdownToWhatsApp(text: string): string {
  if (!text) return text;

  // 1. Protect fenced code blocks (already WhatsApp-compatible)
  const fences: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (m) => {
    fences.push(m);
    return `\x00F${fences.length - 1}`;
  });

  // 2. Protect inline code
  const codes: string[] = [];
  result = result.replace(/`[^`\n]+`/g, (m) => {
    codes.push(m);
    return `\x00C${codes.length - 1}`;
  });

  // 3. **bold** or __bold__ → *bold*
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');
  result = result.replace(/__(.+?)__/g, '*$1*');

  // 4. ~~strikethrough~~ → ~strikethrough~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // 5. Restore inline code
  result = result.replace(/\x00C(\d+)/g, (_, i) => codes[Number(i)] ?? '');

  // 6. Restore fenced code blocks
  result = result.replace(/\x00F(\d+)/g, (_, i) => fences[Number(i)] ?? '');

  return result;
}

// ── Message splitting ────────────────────────────────────

/**
 * Split a long message into chunks that fit within a channel's character limit.
 * Prefers splitting at newlines when possible (threshold: 30% of maxLen).
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.3) splitIdx = maxLen;
    if (splitIdx <= 0) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}
