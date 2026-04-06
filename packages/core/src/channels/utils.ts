/**
 * Shared utilities for channel implementations.
 */

// ── Model indicator ─────────────────────────────────────

/** Superscript model labels for compact display. */
const MODEL_LABELS: Record<string, string> = {
  // Anthropic
  'haiku': 'ᴴᴬᴵᴷᵁ',
  'sonnet': 'ˢᴼᴺᴺᴱᵀ',
  'opus': 'ᴼᴾᵁˢ',
  // OpenAI
  'gpt-4o': 'ᴳᴾᵀ⁻⁴ᴼ',
  'gpt-4o-mini': 'ᴳᴾᵀ⁻⁴ᴼ⁻ᴹᴵᴺᴵ',
  'gpt-4.1': 'ᴳᴾᵀ⁻⁴·¹',
  'o3-mini': 'ᴼ³⁻ᴹᴵᴺᴵ',
};

/** Extract short model name from full ID. */
function getModelShortName(modelId: string): string {
  const lower = modelId.toLowerCase();
  // Anthropic family
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('opus')) return 'opus';
  // Extract model name after provider prefix (e.g. "openai/gpt-4o" → "gpt-4o")
  const parts = modelId.split('/');
  return parts[parts.length - 1] || modelId;
}

/**
 * Append a small model indicator to message text.
 * For display only — not stored in DB, not sent to LLM.
 */
export function appendModelIndicator(text: string, modelId: string | undefined): string {
  if (!text || !modelId) return text;
  const shortName = getModelShortName(modelId);
  const label = MODEL_LABELS[shortName] || shortName;
  return `${text}\n\n${label}`;
}

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
