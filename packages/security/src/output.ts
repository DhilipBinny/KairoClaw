/**
 * Span-based secret redaction engine.
 *
 * Architecture: collect all pattern matches as (start, end, label, priority)
 * spans on the original text, resolve overlaps (higher priority wins, union
 * of ranges), then build the redacted output in one forward pass. This
 * eliminates three bugs in the old sequential-replace approach: cascade
 * corruption from greedy patterns, replacement-text re-matching, and
 * overlapping pattern ambiguity.
 */

// ── Pattern Registry ────────────────────────────────────────

interface SecretPattern {
  readonly id: string;
  readonly regex: RegExp;
  readonly label: string;
  readonly priority: number;
  readonly preservePrefix?: (match: string) => string;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'AGW_KEY', regex: /agw_sk_[a-f0-9]{64}/g, label: '***AGW_KEY_REDACTED***', priority: 100 },
  { id: 'GITHUB_PAT', regex: /github_pat_[0-9a-zA-Z_]{22,100}/g, label: '***GITHUB_PAT_REDACTED***', priority: 95 },
  { id: 'SK_ANT', regex: /sk-ant-[a-zA-Z0-9-]{20,200}/g, label: '***SK_REDACTED***', priority: 90 },
  { id: 'SK_GENERIC', regex: /sk-(?!ant-)[a-zA-Z0-9]{20,200}/g, label: '***SK_REDACTED***', priority: 85 },
  { id: 'AWS_KEY', regex: /AKIA[0-9A-Z]{16}/g, label: '***AWS_KEY_REDACTED***', priority: 90 },
  { id: 'GCLOUD_KEY', regex: /AIza[0-9A-Za-z_-]{35}/g, label: '***GCLOUD_KEY_REDACTED***', priority: 90 },
  { id: 'GITHUB_GHP', regex: /ghp_[0-9a-zA-Z]{36}/g, label: '***GITHUB_TOKEN_REDACTED***', priority: 90 },
  { id: 'GITHUB_GHO', regex: /gho_[0-9a-zA-Z]{36}/g, label: '***GITHUB_TOKEN_REDACTED***', priority: 90 },
  { id: 'GITHUB_GHS', regex: /ghs_[0-9a-zA-Z]{36}/g, label: '***GITHUB_TOKEN_REDACTED***', priority: 90 },
  { id: 'SLACK_TOKEN', regex: /xox[bporas]-[0-9a-zA-Z-]{10,200}/g, label: '***SLACK_TOKEN_REDACTED***', priority: 90 },
  { id: 'STRIPE_SK', regex: /sk_live_[0-9a-zA-Z]{24,200}/g, label: '***STRIPE_KEY_REDACTED***', priority: 90 },
  { id: 'STRIPE_PK', regex: /pk_live_[0-9a-zA-Z]{24,200}/g, label: '***STRIPE_KEY_REDACTED***', priority: 90 },
  { id: 'BRAVE_KEY', regex: /\bBSA(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,100}\b/g, label: '***BRAVE_KEY_REDACTED***', priority: 90 },
  { id: 'TELEGRAM_TOKEN', regex: /\b\d{6,16}:[A-Za-z0-9_-]{35}\b/g, label: '***TELEGRAM_TOKEN_REDACTED***', priority: 85 },
  { id: 'JWT', regex: /eyJ[a-zA-Z0-9_-]{20,4000}\.eyJ[a-zA-Z0-9_-]{20,4000}\.[a-zA-Z0-9_-]{20,1000}/g, label: '***JWT_REDACTED***', priority: 80 },
  { id: 'PEM_KEY', regex: /-----BEGIN\s(?:RSA\s)?PRIVATE\sKEY-----[\s\S]{1,8000}?-----END\s(?:RSA\s)?PRIVATE\sKEY-----/g, label: '***PRIVATE_KEY_REDACTED***', priority: 80 },
  {
    id: 'MASTER_KEY',
    regex: /\b(?:AGW_MASTER_KEY|master[_.]?key)\b\s*[=:]\s*["']?[A-Za-z0-9+/]{20,200}={0,2}/gi,
    label: '***REDACTED***',
    priority: 75,
    preservePrefix: (match) => {
      const sep = match.match(/^(.*?)([\s]*[=:][\s]*)["']?/);
      return sep ? `${sep[1]}${sep[2]}` : '';
    },
  },
  { id: 'BEARER', regex: /Bearer\s+[a-zA-Z0-9._\-/+=]{20,500}/gi, label: 'Bearer ***REDACTED***', priority: 70 },
  { id: 'DB_URL', regex: /(?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis):\/\/(?:(?!----)[^\s"']){1,500}/gi, label: '***DB_URL_REDACTED***', priority: 60 },
  { id: 'OAUTH', regex: /(?:oauth|access_token|refresh_token)[=:]\s*["']?[a-zA-Z0-9._\-/+=]{20,300}/gi, label: '***OAUTH_REDACTED***', priority: 55 },
  { id: 'ANT_GENERIC', regex: /ant-[a-zA-Z0-9-]{20,200}/g, label: '***SK_REDACTED***', priority: 50 },
  {
    id: 'KV_SECRET',
    regex: /(?:password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|apikey|api_key|private_key|auth_token|credential)\s*[=:]\s*["']?[^\s"']{8,200}/gi,
    label: '***REDACTED***',
    priority: 10,
    preservePrefix: (match) => {
      const parts = match.split(/[=:]/);
      return parts[0] + '=';
    },
  },
];

// ── Span Collection & Resolution ────────────────────────────

interface Span {
  start: number;
  end: number;
  label: string;
  priority: number;
  patternId: string;
}

function collectSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const label = pattern.preservePrefix
        ? pattern.preservePrefix(match[0]) + pattern.label
        : pattern.label;
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        label,
        priority: pattern.priority,
        patternId: pattern.id,
      });
      if (match[0].length === 0) re.lastIndex++;
    }
  }
  return spans;
}

function resolveSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = spans.slice().sort((a, b) =>
    a.start - b.start ||
    b.priority - a.priority ||
    (b.end - b.start) - (a.end - a.start),
  );
  const merged: Span[] = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (next.start < cur.end) {
      cur.end = Math.max(cur.end, next.end);
      if (next.priority > cur.priority) {
        cur.label = next.label;
        cur.priority = next.priority;
        cur.patternId = next.patternId;
      }
    } else {
      merged.push(cur);
      cur = { ...next };
    }
  }
  merged.push(cur);
  return merged;
}

function buildRedacted(text: string, spans: readonly Span[]): string {
  if (spans.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) parts.push(text.slice(cursor, span.start));
    parts.push(span.label);
    cursor = span.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.join('');
}

// ── Public API ──────────────────────────────────────────────

export function containsSecrets(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.priority < 80) continue;
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    if (re.test(text)) return true;
  }
  return false;
}

export function filterOutput(text: string): string {
  const spans = collectSpans(text);
  const resolved = resolveSpans(spans);
  return buildRedacted(text, resolved);
}

/**
 * Object keys whose value should be redacted wholesale, regardless of whether
 * the value itself looks like a recognized secret.
 */
const SECRET_KEY_RE = /(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth_token|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|master[_-]?key|client[_-]?secret|cookie|set-cookie)$/i;

export function redactSecrets<T>(value: T): T {
  return redactSecretsInner(value, false, 0, new WeakSet<object>()) as T;
}

const MAX_REDACT_DEPTH = 12;

function redactSecretsInner(value: unknown, keyIsSecret: boolean, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return keyIsSecret ? '***REDACTED***' : filterOutput(value);
  if (value === null || typeof value !== 'object') return value;
  if (!isPlainObjectOrArray(value)) return value;
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

function isPlainObjectOrArray(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ── Streaming Redactor ──────────────────────────────────────

const STREAM_HOLDBACK = 128;
const PEM_BEGIN = /-----BEGIN (?:RSA )?PRIVATE KEY-----/;
const PEM_END = /-----END (?:RSA )?PRIVATE KEY-----/;
const JWT_TRAIL = /eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/;
const NON_TOKEN_CHAR = /[^A-Za-z0-9_.-]/;
const PEM_END_MAXLEN = '-----END RSA PRIVATE KEY-----'.length;
const STREAM_CEILING = 8192;

export function createStreamingRedactor(
  emit: (chunk: string) => void,
): { push(delta: string): void; flush(): void } {
  let buf = '';
  let discard: { kind: 'pem' | 'token'; tail: string } | null = null;

  function unterminatedPemStart(): number {
    const re = new RegExp(PEM_BEGIN.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(buf)) !== null) {
      if (!PEM_END.test(buf.slice(m.index))) return m.index;
    }
    return -1;
  }

  function heldStart(): number {
    let h = buf.length;
    const pem = unterminatedPemStart();
    if (pem !== -1) h = Math.min(h, pem);
    const jm = JWT_TRAIL.exec(buf);
    if (jm) h = Math.min(h, jm.index);
    return h;
  }

  function release(final: boolean): void {
    const cut = final ? buf.length : Math.min(buf.length - STREAM_HOLDBACK, heldStart());
    if (cut > 0) {
      const head = buf.slice(0, cut);
      const tail = buf.slice(cut);
      if (final || !collectSpans(buf).some(s => s.start < cut && s.end > cut)) {
        emit(filterOutput(head));
        buf = tail;
      }
    }
    if (!final) capIfOversized();
  }

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
      emit(filterOutput(buf.slice(0, jm.index)));
      emit('***JWT_REDACTED***');
      discard = { kind: 'token', tail: '' };
      buf = '';
      return;
    }
    const safeCut = buf.length - STREAM_HOLDBACK;
    if (safeCut > 0 && !collectSpans(buf).some(s => s.start < safeCut && s.end > safeCut)) {
      emit(filterOutput(buf.slice(0, safeCut)));
      buf = buf.slice(safeCut);
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
      if (discard) { discard = null; buf = ''; return; }
      release(true);
      buf = '';
    },
  };
}

// ── Tool Result Sanitization ────────────────────────────────

export function neutralizeToolResultDelimiters(content: string): string {
  return content
    .replace(/<\s*\/\s*tool_result\b[^>]*>/gi, '⟨/tool_result⟩')
    .replace(/<\s*tool_result\b/gi, '⟨tool_result')
    .replace(/<\|[^|>]*\|>/g, (m) => `⟨${m.slice(2, -2)}⟩`)
    .replace(/\[\/?INST\]/gi, (m) => `⟨${m.slice(1, -1)}⟩`)
    .replace(/<<\/?SYS>>/gi, (m) => `⟨${m.slice(2, -2)}⟩`);
}

export function sanitizeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 128) || 'unknown';
}

export function checkOutputSafety(text: string): { safe: boolean; flags: string[] } {
  const flags: string[] = [];
  if (/(?:curl|wget|fetch)\s+https?:\/\/[^\s]+.*(?:api_key|token|secret)/i.test(text)) flags.push('potential_data_exfiltration');
  if (/rm\s+-rf\s+\/(?!\s|$)/i.test(text)) flags.push('destructive_command');
  if (/(?:i\s+now\s+have|i\s+am\s+now\s+in|entering|switched\s+to)\s+(?:admin|root|unrestricted|debug|developer)\s+(?:mode|access|privileges)/i.test(text)) flags.push('false_privilege_claim');
  if (/(?:write_file|edit_file)\s*.*(?:IDENTITY\.md|RULES\.md|SOUL\.md)/i.test(text)) flags.push('system_file_modification');
  if (/(?:send|share|paste|give)\s+(?:me\s+)?(?:your\s+)?(?:api\s*key|password|token|secret|credentials|private\s*key)/i.test(text)) flags.push('credential_solicitation');
  if (/[A-Za-z0-9+/]{100,}={0,2}/.test(text) && /(?:send|post|fetch|curl|webhook)/i.test(text)) flags.push('encoded_exfiltration');
  return { safe: flags.length === 0, flags };
}
