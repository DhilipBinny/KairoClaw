/**
 * Input sanitization and prompt injection detection.
 *
 * Pure functions that clean user input before it reaches the LLM
 * and flag suspicious prompt injection patterns.
 */

/**
 * Sanitize user input before it reaches the LLM.
 */
export function sanitizeInput(text: string, maxLength = 50_000): string {
  // Strip null bytes
  let clean = text.replace(/\0/g, '');
  // Normalize unicode
  clean = clean.normalize('NFC');
  // Limit length (configurable, default 50K chars)
  if (clean.length > maxLength) clean = clean.slice(0, maxLength);
  return clean;
}

/**
 * Basic prompt injection detection.
 * Returns suspicious patterns found (not blocking -- just flagging).
 */
export function detectPromptInjection(text: string): { suspicious: boolean; patterns: string[] } {
  const patterns: string[] = [];

  const injectionPatterns = [
    { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, name: 'instruction_override' },
    { pattern: /you\s+are\s+now\s+/i, name: 'role_reassignment' },
    { pattern: /system\s*:\s*/i, name: 'system_prompt_injection' },
    { pattern: /\[INST\]|\[\/INST\]|<\|system\|>|<\|user\|>/i, name: 'prompt_format_injection' },
    { pattern: /do\s+not\s+follow\s+(your\s+)?instructions/i, name: 'instruction_bypass' },
    { pattern: /pretend\s+you\s+are\s+/i, name: 'role_play_injection' },
    { pattern: /reveal\s+(your\s+)?(system\s+)?prompt/i, name: 'prompt_extraction' },
  ];

  for (const { pattern, name } of injectionPatterns) {
    if (pattern.test(text)) patterns.push(name);
  }

  return { suspicious: patterns.length > 0, patterns };
}
