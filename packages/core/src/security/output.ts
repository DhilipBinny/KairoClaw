/**
 * Output filtering and safety checks.
 *
 * Pure functions that redact secrets from LLM output and flag
 * potentially harmful content before it reaches the user.
 */

/**
 * Filter LLM output before sending to user.
 * Redacts secrets, API keys, and sensitive patterns.
 */
export function filterOutput(text: string): string {
  let filtered = text;

  // Redact Kairo API keys
  filtered = filtered.replace(/agw_sk_[a-f0-9]{64}/g, 'agw_sk_***REDACTED***');

  // Redact OpenAI-style keys (sk-...)
  filtered = filtered.replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***REDACTED***');

  // Redact Anthropic tokens (ant-...)
  filtered = filtered.replace(/ant-[a-zA-Z0-9-]{20,}/g, 'ant-***REDACTED***');

  // Redact Bearer tokens
  filtered = filtered.replace(/Bearer\s+[a-zA-Z0-9._\-/+=]{20,}/gi, 'Bearer ***REDACTED***');

  // Redact JWT tokens (eyJ...)
  filtered = filtered.replace(/eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, '***JWT_REDACTED***');

  // Redact database connection strings
  filtered = filtered.replace(/(?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis):\/\/[^\s"']+/gi, '***DB_URL_REDACTED***');

  // Redact OAuth tokens
  filtered = filtered.replace(/(?:oauth|access_token|refresh_token)[=:]\s*["']?[a-zA-Z0-9._\-/+=]{20,}/gi, '***OAUTH_REDACTED***');

  // Redact common secret patterns (password=, secret=, token=, etc.)
  filtered = filtered.replace(
    /(?:password|secret|token|apikey|api_key|private_key|auth_token)\s*[=:]\s*["']?[^\s"']{8,}/gi,
    (match) => {
      const parts = match.split(/[=:]/);
      return parts[0] + '=***REDACTED***';
    },
  );

  return filtered;
}

/**
 * Check if output contains potentially harmful content.
 * Returns flags for review (not blocking).
 */
export function checkOutputSafety(text: string): { safe: boolean; flags: string[] } {
  const flags: string[] = [];

  // Check for potential data exfiltration attempts
  if (/(?:curl|wget|fetch)\s+https?:\/\/[^\s]+.*(?:api_key|token|secret)/i.test(text)) {
    flags.push('potential_data_exfiltration');
  }

  // Check for destructive command suggestions
  if (/rm\s+-rf\s+\/(?!\s|$)/i.test(text)) {
    flags.push('destructive_command');
  }

  return { safe: flags.length === 0, flags };
}
