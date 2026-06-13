/**
 * Whether `text` contains something that looks like a secret/credential, using
 * the same recognized patterns as filterOutput. Used to block secrets being
 * placed in outbound tool-call arguments (#195).
 */
export function containsSecrets(text: string): boolean {
  return filterOutput(text) !== text;
}

export function filterOutput(text: string): string {
  let filtered = text;

  filtered = filtered.replace(/agw_sk_[a-f0-9]{64}/g, 'agw_sk_***REDACTED***');
  filtered = filtered.replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***REDACTED***');
  filtered = filtered.replace(/ant-[a-zA-Z0-9-]{20,}/g, 'ant-***REDACTED***');
  filtered = filtered.replace(/Bearer\s+[a-zA-Z0-9._\-/+=]{20,}/gi, 'Bearer ***REDACTED***');
  filtered = filtered.replace(/eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, '***JWT_REDACTED***');
  filtered = filtered.replace(/(?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis):\/\/[^\s"']+/gi, '***DB_URL_REDACTED***');
  filtered = filtered.replace(/(?:oauth|access_token|refresh_token)[=:]\s*["']?[a-zA-Z0-9._\-/+=]{20,}/gi, '***OAUTH_REDACTED***');
  filtered = filtered.replace(/AKIA[0-9A-Z]{16}/g, '***AWS_KEY_REDACTED***');
  filtered = filtered.replace(/AIza[0-9A-Za-z_-]{35}/g, '***GCLOUD_KEY_REDACTED***');
  filtered = filtered.replace(/ghp_[0-9a-zA-Z]{36}/g, '***GITHUB_TOKEN_REDACTED***');
  filtered = filtered.replace(/gho_[0-9a-zA-Z]{36}/g, '***GITHUB_TOKEN_REDACTED***');
  filtered = filtered.replace(/ghs_[0-9a-zA-Z]{36}/g, '***GITHUB_TOKEN_REDACTED***');
  filtered = filtered.replace(/github_pat_[0-9a-zA-Z_]{22,}/g, '***GITHUB_PAT_REDACTED***');
  filtered = filtered.replace(/xox[bporas]-[0-9a-zA-Z-]{10,}/g, '***SLACK_TOKEN_REDACTED***');
  filtered = filtered.replace(/sk_live_[0-9a-zA-Z]{24,}/g, '***STRIPE_KEY_REDACTED***');
  filtered = filtered.replace(/pk_live_[0-9a-zA-Z]{24,}/g, '***STRIPE_KEY_REDACTED***');
  filtered = filtered.replace(/-----BEGIN\s(?:RSA\s)?PRIVATE\sKEY-----[\s\S]*?-----END\s(?:RSA\s)?PRIVATE\sKEY-----/g, '***PRIVATE_KEY_REDACTED***');
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
 * Defang attempts by tool-result content to break out of its `<tool_result>`
 * wrapper. Without this, externally-controlled content (a web page, an MCP
 * server response) could embed a literal `</tool_result>` followed by forged
 * "system" instructions — which would then appear OUTSIDE the wrapper the model
 * is told to distrust, defeating the tool-result trust boundary. We replace the
 * delimiters with a visually-similar but inert form so the boundary the agent
 * loop adds is the only real one. Also defangs a few other turn/role delimiters
 * content might use to forge a new turn.
 */
export function neutralizeToolResultDelimiters(content: string): string {
  return content
    // closing tag in any form: </tool_result>, </tool_result >, </tool_result/>, </tool_result foo="bar">
    .replace(/<\s*\/\s*tool_result\b[^>]*>/gi, '⟨/tool_result⟩')
    .replace(/<\s*tool_result\b/gi, '⟨tool_result')
    // ChatML / role markers (<|system|>, <|im_start|>, <|im_end|>, <|end|>, …)
    .replace(/<\|[^|>]*\|>/g, (m) => `⟨${m.slice(2, -2)}⟩`)
    // Llama-style instruction + system delimiters
    .replace(/\[\/?INST\]/gi, (m) => `⟨${m.slice(1, -1)}⟩`)
    .replace(/<<\/?SYS>>/gi, (m) => `⟨${m.slice(2, -2)}⟩`);
}

/**
 * Sanitize a tool name before it is interpolated into a `<tool_result name="…">`
 * attribute. A name from an untrusted source (e.g. a tool advertised by a
 * malicious MCP server) could otherwise contain quotes/angle-brackets/newlines
 * and forge a wrapper boundary from inside the attribute (#182). Keeps only the
 * characters legitimate tool names use.
 */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 128) || 'unknown';
}

export function checkOutputSafety(text: string): { safe: boolean; flags: string[] } {
  const flags: string[] = [];

  if (/(?:curl|wget|fetch)\s+https?:\/\/[^\s]+.*(?:api_key|token|secret)/i.test(text)) {
    flags.push('potential_data_exfiltration');
  }

  if (/rm\s+-rf\s+\/(?!\s|$)/i.test(text)) {
    flags.push('destructive_command');
  }

  if (/(?:i\s+now\s+have|i\s+am\s+now\s+in|entering|switched\s+to)\s+(?:admin|root|unrestricted|debug|developer)\s+(?:mode|access|privileges)/i.test(text)) {
    flags.push('false_privilege_claim');
  }

  if (/(?:write_file|edit_file)\s*.*(?:IDENTITY\.md|RULES\.md|SOUL\.md)/i.test(text)) {
    flags.push('system_file_modification');
  }

  if (/(?:send|share|paste|give)\s+(?:me\s+)?(?:your\s+)?(?:api\s*key|password|token|secret|credentials|private\s*key)/i.test(text)) {
    flags.push('credential_solicitation');
  }

  if (/[A-Za-z0-9+/]{100,}={0,2}/.test(text) && /(?:send|post|fetch|curl|webhook)/i.test(text)) {
    flags.push('encoded_exfiltration');
  }

  return { safe: flags.length === 0, flags };
}
