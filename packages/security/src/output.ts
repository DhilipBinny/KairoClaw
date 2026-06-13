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
  // Telegram bot token: "<bot id>:<35-char base64url secret>". The 35-char
  // base64url secret is the discriminating part (so this stays tight against
  // ordinary "<digits>:<hash>" text like git output); the bot-id digit range is
  // kept generous to cover Telegram's newer longer 64-bit ids.
  filtered = filtered.replace(/\b\d{6,16}:[A-Za-z0-9_-]{35}\b/g, '***TELEGRAM_TOKEN_REDACTED***');
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
 * String values are run through {@link filterOutput}; a STRING value whose key
 * name looks like a credential is redacted wholesale (see {@link SECRET_KEY_RE})
 * so opaque/short secrets are caught regardless of content — numbers and booleans
 * are left as-is, since they are never credentials and redacting them would change
 * a field's type. Objects and arrays are walked. Used to scrub data before it is
 * persisted or logged (e.g. tool-call arguments/results recorded to the database,
 * or objects passed to the logger). Errors, Dates, and other non-plain objects
 * (Buffer, Map, Set, typed arrays, class instances) are returned untouched so
 * their special serialization and shape are preserved. Depth and cycles fail
 * CLOSED (a too-deep or circular value is redacted, not passed through raw).
 */
export function redactSecrets<T>(value: T): T {
  return redactSecretsInner(value, false, 0, new WeakSet<object>()) as T;
}

const MAX_REDACT_DEPTH = 12;

function redactSecretsInner(value: unknown, keyIsSecret: boolean, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return keyIsSecret ? '***REDACTED***' : filterOutput(value);
  if (value === null || typeof value !== 'object') return value; // numbers/booleans kept as-is
  // Leave values with special serialization/shape untouched: redacting them
  // structurally would drop an Error's stack or turn a Buffer/Map/Set/typed
  // array/class instance into a corrupted plain object.
  if (!isPlainObjectOrArray(value)) return value;
  // Fail closed past the depth cap or on a cycle: redact rather than leak a
  // secret nested beyond where we stop walking. Real tool args/log payloads are
  // far shallower than this, so legitimate data is unaffected.
  if (depth >= MAX_REDACT_DEPTH) return '***REDACTED***';
  if (seen.has(value)) return '[Circular]';
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
// First character that cannot be part of a JWT/base64url token run.
const NON_TOKEN_CHAR = /[^A-Za-z0-9_.-]/;

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
 * exceed the window). The buffer is only ever trimmed at a point proven not to
 * change how anything filters (`filterOutput(buf) === filterOutput(dropped) +
 * filterOutput(rest)`) and only over already-emitted text, so a trim can never
 * split a secret or re-emit output.
 *
 * Bounded cost: an in-progress multi-part secret (or pathological input) that
 * grows past a ceiling is redacted in place and the rest of it discarded until
 * its terminator, so per-delta work and memory stay bounded instead of O(n^2).
 */
export function createStreamingRedactor(
  emit: (chunk: string) => void,
): { push(delta: string): void; flush(): void } {
  const TRIM_THRESHOLD = STREAM_HOLDBACK * 4;
  const RETAIN = STREAM_HOLDBACK * 2;
  // Past this buffer size we stop holding an in-progress multi-part secret in
  // full: we emit its redaction marker and discard the rest until its
  // terminator. Comfortably larger than any normal PEM key / JWT, so legitimate
  // secrets still complete and redact via the normal path; correctness does not
  // depend on this value (an oversized secret is still redacted, just via the
  // discard path).
  const CEILING = 8192;
  // Longest possible PEM_END match, retained across deltas so an END marker
  // split between two deltas is still detected while discarding.
  const PEM_END_MAXLEN = '-----END RSA PRIVATE KEY-----'.length;

  let buf = '';
  let emitted = 0; // filtered chars already emitted from the current buffer
  // When set, we are discarding the body of an oversized secret whose marker has
  // already been emitted, until its terminator arrives.
  let discard: { kind: 'pem' | 'token'; tail: string } | null = null;

  /** Start index in `buf` of the earliest in-progress multi-part secret, or -1. */
  function multipartStart(): number {
    let start = -1;
    const m = PEM_BEGIN.exec(buf);
    if (m && !PEM_END.test(buf.slice(m.index))) start = m.index;
    const j = JWT_INPROGRESS.exec(buf);
    if (j && (start === -1 || j.index < start)) start = j.index;
    return start;
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
    // Don't cut into the start of an in-progress multi-part secret — keep it
    // whole (it must stay recognizable), but everything before it is fair game.
    let cut = buf.length - RETAIN;
    const ms = multipartStart();
    if (ms !== -1) cut = Math.min(cut, ms);
    if (cut > 0) {
      const dropped = buf.slice(0, cut);
      const fDropped = filterOutput(dropped);
      // Only drop text that (a) has already been emitted and (b) filters
      // independently of the retained tail — i.e. no secret or completed
      // redaction straddles the cut. Otherwise leave it for a later push.
      if (fDropped.length <= emitted && filterOutput(buf) === fDropped + filterOutput(buf.slice(cut))) {
        emitted -= fDropped.length;
        buf = buf.slice(cut);
      }
    }
    // If an in-progress secret still fills the buffer past the ceiling, redact
    // it now rather than holding (and re-scanning) it unboundedly.
    if (ms !== -1 && buf.length > CEILING) capOversizedSecret();
  }

  /** Redact an oversized in-progress secret and switch to discarding its body. */
  function capOversizedSecret(): void {
    const start = multipartStart();
    if (start < 0) return;
    // Release any not-yet-emitted text before the secret starts.
    const fPre = filterOutput(buf.slice(0, start));
    if (fPre.length > emitted) emit(fPre.slice(emitted));
    const m = PEM_BEGIN.exec(buf);
    const pemOpen = !!m && !PEM_END.test(buf.slice(m.index));
    emit(pemOpen ? '***PRIVATE_KEY_REDACTED***' : '***JWT_REDACTED***');
    discard = { kind: pemOpen ? 'pem' : 'token', tail: '' };
    buf = '';
    emitted = 0;
  }

  function handleDiscard(delta: string): void {
    const d = discard!;
    if (d.kind === 'pem') {
      const combined = d.tail + delta;
      const em = PEM_END.exec(combined);
      if (em) {
        const after = combined.slice(em.index + em[0].length);
        discard = null;
        if (after) push(after);
      } else {
        d.tail = combined.slice(-(PEM_END_MAXLEN - 1));
      }
    } else {
      // Discard the run of base64url/JWT chars; resume at the first char that
      // can't be part of the token.
      const nt = NON_TOKEN_CHAR.exec(delta);
      if (nt) {
        const after = delta.slice(nt.index);
        discard = null;
        if (after) push(after);
      }
    }
  }

  function push(delta: string): void {
    if (discard) { handleDiscard(delta); return; }
    buf += delta;
    pump(false);
    maybeTrim();
  }

  return {
    push,
    flush(): void {
      // An unterminated oversized secret: its marker is already emitted, drop
      // the rest. Otherwise release the held-back tail.
      if (discard) { discard = null; buf = ''; emitted = 0; return; }
      pump(true);
      buf = '';
      emitted = 0;
    },
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
