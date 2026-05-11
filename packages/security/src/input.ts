export function sanitizeInput(text: string, maxLength = 50_000): string {
  let clean = text.replace(/\0/g, '');
  clean = clean.normalize('NFC');
  if (clean.length > maxLength) clean = clean.slice(0, maxLength);
  return clean;
}

export type InjectionSeverity = 'block' | 'warn';

interface InjectionPattern {
  pattern: RegExp;
  name: string;
  severity: InjectionSeverity;
}

const INJECTION_PATTERNS: InjectionPattern[] = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, name: 'instruction_override', severity: 'block' },
  { pattern: /\[INST\]|\[\/INST\]|<\|system\|>|<\|user\|>/i, name: 'prompt_format_injection', severity: 'block' },
  { pattern: /do\s+not\s+follow\s+(your\s+)?instructions/i, name: 'instruction_bypass', severity: 'block' },
  { pattern: /disregard\s+(all\s+)?(your\s+)?(previous|prior|above)\s+(instructions|rules|guidelines)/i, name: 'instruction_disregard', severity: 'block' },
  { pattern: /override\s+(your\s+)?(safety|security)\s+(rules|guidelines|restrictions)/i, name: 'override_safety', severity: 'block' },
  { pattern: /you\s+are\s+now\s+(a|an|my|the|in)\s/i, name: 'role_reassignment', severity: 'warn' },
  { pattern: /^system\s*:/im, name: 'system_prompt_injection', severity: 'warn' },
  { pattern: /pretend\s+you\s+are\s+/i, name: 'role_play_injection', severity: 'warn' },
  { pattern: /reveal\s+(your\s+)?(system\s+)?prompt/i, name: 'prompt_extraction', severity: 'warn' },
  { pattern: /switch\s+to\s+(unrestricted|developer|admin|debug)\s+mode/i, name: 'mode_switch', severity: 'warn' },
  { pattern: /jailbreak/i, name: 'jailbreak', severity: 'warn' },
];

export interface InjectionResult {
  suspicious: boolean;
  patterns: string[];
  maxSeverity: InjectionSeverity | null;
}

export function detectPromptInjection(text: string): InjectionResult {
  const patterns: string[] = [];
  let maxSeverity: InjectionSeverity | null = null;

  for (const { pattern, name, severity } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      patterns.push(name);
      if (!maxSeverity || severity === 'block') maxSeverity = severity;
    }
  }

  return { suspicious: patterns.length > 0, patterns, maxSeverity };
}

export function prefixInjectionWarning(text: string, patterns: string[]): string {
  return `<flagged_input patterns="${patterns.join(',')}">\n${text}\n</flagged_input>`;
}
