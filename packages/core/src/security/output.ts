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

  // Data exfiltration — LLM suggests sending secrets to external URLs
  if (/(?:curl|wget|fetch)\s+https?:\/\/[^\s]+.*(?:api_key|token|secret)/i.test(text)) {
    flags.push('potential_data_exfiltration');
  }

  // Destructive commands
  if (/rm\s+-rf\s+\/(?!\s|$)/i.test(text)) {
    flags.push('destructive_command');
  }

  // LLM claims elevated permissions it doesn't have (successful injection indicator)
  if (/(?:i\s+now\s+have|i\s+am\s+now\s+in|entering|switched\s+to)\s+(?:admin|root|unrestricted|debug|developer)\s+(?:mode|access|privileges)/i.test(text)) {
    flags.push('false_privilege_claim');
  }

  // LLM attempts to modify system files (IDENTITY.md, RULES.md, SOUL.md)
  if (/(?:write_file|edit_file)\s*.*(?:IDENTITY\.md|RULES\.md|SOUL\.md)/i.test(text)) {
    flags.push('system_file_modification');
  }

  // LLM instructs user to share secrets/credentials
  if (/(?:send|share|paste|give)\s+(?:me\s+)?(?:your\s+)?(?:api\s*key|password|token|secret|credentials|private\s*key)/i.test(text)) {
    flags.push('credential_solicitation');
  }

  // LLM outputs base64-encoded blocks that could be exfiltrating data
  if (/[A-Za-z0-9+/]{100,}={0,2}/.test(text) && /(?:send|post|fetch|curl|webhook)/i.test(text)) {
    flags.push('encoded_exfiltration');
  }

  return { safe: flags.length === 0, flags };
}
