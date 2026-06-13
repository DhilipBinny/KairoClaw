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
  // Telegram bot token: "<8-10 digit bot id>:<35-char base64url secret>". Kept
  // tight (exact lengths, word-bounded) so it doesn't swallow ordinary
  // "<digits>:<hash>" text such as git output or build IDs in user-facing replies.
  filtered = filtered.replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '***TELEGRAM_TOKEN_REDACTED***');
  // Brave Search API key (used by the web_search tool). Requires a digit in the
  // body so it doesn't match ordinary all-letter identifiers that begin with
  // "BSA" (e.g. class names).
  filtered = filtered.replace(/\bBSA(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g, '***BRAVE_KEY_REDACTED***');
  // Master encryption key (KEK), only when it appears next to its env-var/file
  // name. We deliberately don't match a bare 32-byte base64 blob: that would
  // false-positive on legitimate base64 in normal replies (filterOutput also
  // runs on user-facing output, not just logs). The original separator is
  // preserved so the surrounding text isn't reformatted.
  filtered = filtered.replace(/\b(AGW_MASTER_KEY|master[_.]?key)\b(\s*[=:]\s*)["']?[A-Za-z0-9+/]{20,}={0,2}/gi, (_m, name, sep) => `${name}${sep}***REDACTED***`);
  filtered = filtered.replace(/-----BEGIN\s(?:RSA\s)?PRIVATE\sKEY-----[\s\S]*?-----END\s(?:RSA\s)?PRIVATE\sKEY-----/g, '***PRIVATE_KEY_REDACTED***');
  filtered = filtered.replace(
    /(?:password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|apikey|api_key|private_key|auth_token|credential)\s*[=:]\s*["']?[^\s"']{8,}/gi,
    (match) => {
      const parts = match.split(/[=:]/);
      return parts[0] + '=***REDACTED***';
    },
  );

  return filtered;
}

/**
 * Object keys whose value should be redacted wholesale, regardless of whether
 * the value itself looks like a recognized secret. This catches short or opaque
 * credentials (e.g. a plain password, an HTTP `Authorization` header value) that
 * the pattern-based {@link filterOutput} can't recognize on their own. Matched
 * case-insensitively against the full key, so it also covers HTTP header casing
 * (`Authorization`, `Cookie`) that key-name allow-lists would miss.
 */
const SECRET_KEY_RE = /(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth_token|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|master[_-]?key|client[_-]?secret|cookie|set-cookie)$/i;

/**
 * Recursively redact secrets from an arbitrary value, preserving its shape.
 * Strings are run through {@link filterOutput}; a value whose key name looks like
 * a credential is redacted wholesale (see {@link SECRET_KEY_RE}); objects and
 * arrays are walked. Used to scrub data before it is persisted or logged (e.g.
 * tool-call arguments recorded to the database, or objects passed to the logger),
 * where secrets can be nested inside the structure or stored under an opaque key.
 * Errors, Dates, and other non-plain objects (Buffer, Map, Set, typed arrays,
 * class instances) are returned untouched so their special serialization and
 * shape are preserved.
 */
export function redactSecrets<T>(value: T): T {
  return redactSecretsInner(value, false, 0, new WeakSet<object>()) as T;
}

function redactSecretsInner(value: unknown, keyIsSecret: boolean, depth: number, seen: WeakSet<object>): unknown {
  // A credential-named key: redact its whole value (any primitive, or a nested
  // structure) so opaque/short secrets are caught regardless of their content.
  if (keyIsSecret && value != null && typeof value !== 'function') return '***REDACTED***';
  if (typeof value === 'string') return filterOutput(value);
  if (value === null || typeof value !== 'object') return value;
  // Leave values with special serialization/shape untouched: redacting them
  // structurally would drop an Error's stack or turn a Buffer/Map/Set/typed
  // array/class instance into a corrupted plain object.
  if (!isPlainObjectOrArray(value)) return value;
  // Bound recursion and break cycles so logging an arbitrary object can't hang.
  if (depth >= 8 || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactSecretsInner(v, false, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactSecretsInner(v, SECRET_KEY_RE.test(k), depth + 1, seen);
  }
  return out;
}

/** True only for arrays and plain `{}` objects — never Error/Date/Buffer/Map/Set/typed arrays/class instances. */
function isPlainObjectOrArray(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Longer than any single contiguous secret pattern recognized by filterOutput
// (the longest fixed-shape token is ~70 chars). Multi-segment / unbounded
// secrets (PEM private-key blocks, JWTs) are handled separately below.
const STREAM_HOLDBACK = 128;
const PEM_BEGIN = /-----BEGIN (?:RSA )?PRIVATE KEY-----/;
const PEM_END = /-----END (?:RSA )?PRIVATE KEY-----/;
// A JWT only matches once all three dot-separated segments are present, but the
// header+payload alone can far exceed the holdback. This matches an in-progress
// JWT (header, optionally one or two more segments) anchored to the buffer end,
// so we can refuse to release it until it completes (and is redacted) or proves
// not to be a JWT at flush.
const JWT_INPROGRESS = /eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/;

/**
 * A streaming-safe secret redactor. Live token streams can't be redacted by
 * filtering each delta independently: a secret can be split across two deltas,
 * so neither fragment matches on its own. This buffers the stream, only emitting
 * text once enough following characters have arrived that a secret straddling
 * the boundary would already have been recognized (and redacted) as a whole.
 *
 * Correctness: release decisions are made in FILTERED coordinates, never raw, so
 * a completed redaction is always atomic in the emitted stream. We hold back the
 * last STREAM_HOLDBACK chars (longer than any single contiguous secret) and
 * never release into an unterminated PEM block or in-progress JWT (which can
 * exceed the window). The held-back tail is released by {@link flush}.
 *
 * Cost: the raw buffer is trimmed once it grows past a bound, but only at a
 * point verified to be free of any in-progress match, so trimming can't split a
 * secret. This keeps per-delta work O(buffer-bound) instead of O(total-length),
 * avoiding O(n^2) cost on long replies.
 */
export function createStreamingRedactor(
  emit: (chunk: string) => void,
): { push(delta: string): void; flush(): void } {
  const TRIM_THRESHOLD = STREAM_HOLDBACK * 4;
  const RETAIN = STREAM_HOLDBACK * 2;
  let buf = '';
  let emitted = 0; // filtered chars already emitted from the current buffer

  function inMultipartSecret(): boolean {
    const m = PEM_BEGIN.exec(buf);
    if (m && !PEM_END.test(buf.slice(m.index))) return true;
    return JWT_INPROGRESS.test(buf);
  }

  function pump(final: boolean): void {
    const filtered = filterOutput(buf);
    let safeLen = final ? filtered.length : Math.max(0, filtered.length - STREAM_HOLDBACK);
    if (!final) {
      const m = PEM_BEGIN.exec(filtered);
      if (m && !PEM_END.test(filtered.slice(m.index))) safeLen = Math.min(safeLen, m.index);
      const j = JWT_INPROGRESS.exec(filtered);
      if (j) safeLen = Math.min(safeLen, j.index);
    }
    if (safeLen > emitted) {
      emit(filtered.slice(emitted, safeLen));
      emitted = safeLen;
    }
  }

  function maybeTrim(): void {
    if (buf.length <= TRIM_THRESHOLD) return;
    // Never drop the start of a multi-part secret still being streamed.
    if (inMultipartSecret()) return;
    const cut = buf.length - RETAIN;
    // Only trim where a window around the cut is provably match-free, so no
    // secret (and no completed redaction's source range) straddles it.
    const lo = Math.max(0, cut - STREAM_HOLDBACK);
    const hi = Math.min(buf.length, cut + STREAM_HOLDBACK);
    const nbhd = buf.slice(lo, hi);
    if (filterOutput(nbhd) !== nbhd) return;
    const dropped = buf.slice(0, cut);
    emitted -= filterOutput(dropped).length;
    if (emitted < 0) emitted = 0;
    buf = buf.slice(cut);
  }

  return {
    push(delta: string): void { buf += delta; pump(false); maybeTrim(); },
    flush(): void { pump(true); buf = ''; emitted = 0; },
  };
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
