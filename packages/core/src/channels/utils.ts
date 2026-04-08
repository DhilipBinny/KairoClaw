/**
 * Shared utilities for channel implementations.
 */

// ── Model indicator ─────────────────────────────────────

const SUPERSCRIPT_MAP: Record<string, string> = {
  'A': 'ᴬ', 'B': 'ᴮ', 'C': 'ᶜ', 'D': 'ᴰ', 'E': 'ᴱ', 'F': 'ᶠ', 'G': 'ᴳ', 'H': 'ᴴ',
  'I': 'ᴵ', 'J': 'ᴶ', 'K': 'ᴷ', 'L': 'ᴸ', 'M': 'ᴹ', 'N': 'ᴺ', 'O': 'ᴼ', 'P': 'ᴾ',
  'Q': 'ᵠ', 'R': 'ᴿ', 'S': 'ˢ', 'T': 'ᵀ', 'U': 'ᵁ', 'V': 'ⱽ', 'W': 'ᵂ', 'X': 'ˣ',
  'Y': 'ʸ', 'Z': 'ᶻ',
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '-': '⁻', '.': '·', ' ': ' ',
};

/**
 * Convert a string to Unicode superscript characters.
 * Characters not in the map pass through unchanged.
 *
 * @example
 * toSuperscript('gpt-4.1-mini') // 'ᴳᴾᵀ⁻⁴·¹⁻ᴹᴵᴺᴵ'
 * toSuperscript('claude-4-opus') // 'ᶜᴸᴬᵁᴰᴱ⁻⁴⁻ᴼᴾᵁˢ'
 */
export function toSuperscript(label: string): string {
  return [...label.toUpperCase()].map((c) => SUPERSCRIPT_MAP[c] ?? c).join('');
}

/**
 * Extract short model name from full model ID.
 * Exported so the WebSocket payload can send the resolved short name,
 * avoiding duplicated resolution logic in the UI.
 */
export function getModelShortName(modelId: string): string {
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
 * Determine if the model indicator should be shown for a given user role.
 * - 'off': never shown
 * - 'admin_only': shown to admin and power_user roles only
 * - 'all': shown to all users
 */
export function shouldShowModelIndicator(
  setting: string | undefined,
  userRole: string | undefined,
): boolean {
  if (!setting || setting === 'off') return false;
  if (setting === 'all') return true;
  // 'admin_only': show for admin and power_user
  return userRole === 'admin' || userRole === 'power_user';
}

/**
 * Append a small model indicator to message text.
 * For display only — not stored in DB, not sent to LLM.
 */
export function appendModelIndicator(text: string, modelId: string | undefined): string {
  if (!text || !modelId) return text;
  const shortName = getModelShortName(modelId);
  return `${text}\n\n${toSuperscript(shortName)}`;
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
