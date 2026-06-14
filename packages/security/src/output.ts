/**
 * Whether `text` contains something that looks like a secret/credential, using
 * the same recognized patterns as filterOutput. Used to block secrets being
 * placed in outbound tool-call arguments (#195).
 */
/**
 * High-confidence secret detection for BLOCKING egress tool calls.
 * Unlike filterOutput (which over-matches safely for redaction), this only
 * triggers on patterns with known prefixes or high entropy — false positives
 * here block legitimate tool calls, not just mask text.
 */
export function containsSecrets(text: string): boolean {
  const patterns = [
    /agw_sk_[a-f0-9]{64}/,
    /sk-[a-zA-Z0-9]{20,}/,
    /sk-ant-[a-zA-Z0-9-]{20,}/,
    /Bearer\s+[a-zA-Z0-9._\-/+=]{40,}/i,
    /eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/,
    /(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s"']+/i,
    /AKIA[0-9A-Z]{16}/,
    /AIza[0-9A-Za-z_-]{35}/,
    /ghp_[0-9a-zA-Z]{36}/,
    /gho_[0-9a-zA-Z]{36}/,
    /ghs_[0-9a-zA-Z]{36}/,
    /github_pat_[0-9a-zA-Z_]{22,}/,
    /xox[bporas]-[0-9a-zA-Z-]{10,}/,
    /sk_live_[0-9a-zA-Z]{24,}/,
    /\b\d{6,16}:[A-Za-z0-9_-]{35}\b/,
    /-----BEGIN\s(?:RSA\s)?PRIVATE\sKEY-----/,
  ];
  return patterns.some(p => p.test(text));
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
// A trailing run that could still grow into (or extend) a JWT: a header,
// optionally one or two further dot-separated segments, anchored to the buffer
// end. Run against the RAW buffer so an intermediate redaction can't sever it.
const JWT_TRAIL = /eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/;
// First character that cannot be part of a JWT/base64url token run.
const NON_TOKEN_CHAR = /[^A-Za-z0-9_.-]/;
// Longest possible PEM_END match, retained across deltas while discarding so an
// END marker split between two deltas is still detected.
const PEM_END_MAXLEN = '-----END RSA PRIVATE KEY-----'.length;
// Past this buffer size an in-progress multi-part secret is redacted in place
// and its body discarded until the terminator, bounding CPU/memory. Comfortably
// larger than any real key/JWT, so legitimate secrets still redact via the
// normal path; correctness does not depend on this value.
const STREAM_CEILING = 8192;

/**
 * A streaming-safe secret redactor. Live token streams can't be redacted by
 * filtering each delta independently: a secret can be split across two deltas,
 * so neither fragment matches on its own. This buffers the stream and releases a
 * prefix only once it is provably final.
 *
 * Invariant: for any chunking, `concat(emitted) + flush === filterOutput(whole
 * input)`, except that an in-progress secret which grows past STREAM_CEILING is
 * collapsed to its redaction marker (still safe — it is never emitted raw).
 *
 * How: all reasoning is in RAW coordinates. We release the prefix `buf[:cut]`
 * only when (a) `cut` is not inside an in-progress multi-part secret (PEM with no
 * END yet, or a trailing JWT-ish run that could still grow), and (b) it filters
 * independently of the rest — `filterOutput(buf) === filterOutput(head) +
 * filterOutput(tail)` — which guarantees no bounded match or completed redaction
 * straddles the cut. The released head is dropped from the buffer, so cost stays
 * O(total) for normal text; an oversized in-progress secret is capped.
 */
export function createStreamingRedactor(
  emit: (chunk: string) => void,
): { push(delta: string): void; flush(): void } {
  let buf = ''; // raw, not-yet-emitted
  // When set, we are discarding the body of an oversized secret whose marker has
  // already been emitted, until its terminator arrives.
  let discard: { kind: 'pem' | 'token'; tail: string } | null = null;

  /** Index of the first `-----BEGIN…` that has no matching END after it, else -1. */
  function unterminatedPemStart(): number {
    const re = new RegExp(PEM_BEGIN.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(buf)) !== null) {
      if (!PEM_END.test(buf.slice(m.index))) return m.index;
    }
    return -1;
  }

  /** Earliest raw index that must be HELD (could still change with more input). */
  function heldStart(): number {
    let h = buf.length;
    const pem = unterminatedPemStart();
    if (pem !== -1) h = Math.min(h, pem);
    const jm = JWT_TRAIL.exec(buf);
    // Hold any trailing eyJ run until it resolves — we can't tell a forming JWT
    // (whose header alone can be large, e.g. an x5c cert chain) from ordinary
    // base64 until a non-token char or the dots arrive. Oversized runs are
    // handled by the ceiling.
    if (jm) h = Math.min(h, jm.index);
    return h;
  }

  function release(final: boolean): void {
    const cut = final ? buf.length : Math.min(buf.length - STREAM_HOLDBACK, heldStart());
    if (cut > 0) {
      const head = buf.slice(0, cut);
      const tail = buf.slice(cut);
      // Final flush releases everything; otherwise only release a prefix that
      // filters independently of the held tail (no match straddles the cut).
      if (final || filterOutput(buf) === filterOutput(head) + filterOutput(tail)) {
        emit(filterOutput(head));
        buf = tail;
      }
    }
    if (!final) capIfOversized();
  }

  /** Cap an in-progress secret that has grown past the ceiling. */
  function capIfOversized(): void {
    if (buf.length <= STREAM_CEILING) return;
    const pem = unterminatedPemStart();
    if (pem !== -1) {
      emit(filterOutput(buf.slice(0, pem)));
      emit('***PRIVATE_KEY_REDACTED***');
      discard = { kind: 'pem', tail: buf.slice(pem).slice(-(PEM_END_MAXLEN - 1)) };
      buf = '';
      return;
    }
    const jm = JWT_TRAIL.exec(buf);
    if (jm) {
      // An eyJ run still unresolved at the ceiling is redacted rather than
      // released raw: we can't yet rule out a JWT (header alone may be huge), and
      // never-leak takes priority over the rare over-redaction of a large
      // eyJ-prefixed base64 blob.
      emit(filterOutput(buf.slice(0, jm.index)));
      emit('***JWT_REDACTED***');
      discard = { kind: 'token', tail: '' };
      buf = '';
      return;
    }
    // No in-progress secret occupying the buffer. Force-release the safe prefix
    // to keep memory bounded.
    const cut = buf.length - STREAM_HOLDBACK;
    if (cut > 0 && filterOutput(buf) === filterOutput(buf.slice(0, cut)) + filterOutput(buf.slice(cut))) {
      emit(filterOutput(buf.slice(0, cut)));
      buf = buf.slice(cut);
    }
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
      // Discard the base64url/JWT run; resume at the first non-token char.
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
    release(false);
  }

  return {
    push,
    flush(): void {
      // An unterminated oversized secret: its marker is already emitted, drop
      // the rest. Otherwise release everything that remains.
      if (discard) { discard = null; buf = ''; return; }
      release(true);
      buf = '';
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
