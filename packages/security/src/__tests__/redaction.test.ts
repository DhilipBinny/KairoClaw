import { describe, it, expect } from 'vitest';
import { filterOutput, containsSecrets, redactSecrets, createStreamingRedactor } from '../output.js';

// A well-formed Telegram bot token: <9-digit bot id>:<35-char base64url secret>.
const TG_TOKEN = '123456789:AAHfakeTokenABCDEFGHIJKLMNOPQRSTUVW';

describe('filterOutput — added secret patterns (#185)', () => {
  it('redacts a Telegram bot token', () => {
    const out = filterOutput(`bot=${TG_TOKEN} done`);
    expect(out).not.toContain('AAHfakeToken');
    expect(out).toContain('***TELEGRAM_TOKEN_REDACTED***');
    expect(out).toContain('done');
  });

  it('does not over-match ordinary digit:hash text (git output, build ids)', () => {
    const samples = [
      'git log 12345678:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      'Build 20240613:DEADBEEFCAFEBABE1234567890ABCDEFGHIJ passed',
      'PID 482910: connection refused',
    ];
    for (const s of samples) expect(filterOutput(s)).toBe(s);
  });

  it('redacts a Brave Search API key', () => {
    const out = filterOutput('key BSA1234567890abcdefABCDEF_xyz end');
    expect(out).not.toContain('BSA1234567890abcdefABCDEF');
    expect(out).toContain('***BRAVE_KEY_REDACTED***');
  });

  it('does not redact all-letter identifiers that merely start with BSA', () => {
    const samples = [
      'class BSAuthenticationManagerControllerService {}',
      'BSAttachmentViewerControllerDelegateProtocol',
    ];
    for (const s of samples) expect(filterOutput(s)).toBe(s);
  });

  it('redacts the master key but preserves the original separator', () => {
    expect(filterOutput('AGW_MASTER_KEY=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3OA=='))
      .toBe('AGW_MASTER_KEY=***REDACTED***');
    // colon separator is kept, not rewritten to '='
    expect(filterOutput('master_key: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXox'))
      .toBe('master_key: ***REDACTED***');
  });

  it('does not redact a bare base64 blob in normal output (no master-key false positives)', () => {
    const blob = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3OA==';
    expect(filterOutput(`here is the data: ${blob}`)).toContain(blob);
  });

  it('redacts additional keyword=value synonyms (free text)', () => {
    expect(filterOutput('client_secret=abcdefgh12345')).toContain('client_secret=***REDACTED***');
    expect(filterOutput('pwd=hunter2hunter2')).toContain('pwd=***REDACTED***');
  });

  it('containsSecrets reflects the new patterns', () => {
    expect(containsSecrets(TG_TOKEN)).toBe(true);
    expect(containsSecrets('just a normal sentence with no secrets')).toBe(false);
  });
});

describe('redactSecrets — deep structural redaction (#185)', () => {
  it('redacts secrets in nested objects and arrays, preserving shape', () => {
    const input = {
      tool: 'send_email',
      args: { to: 'a@b.com', note: 'token sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' },
      list: ['plain', 'AKIAIOSFODNN7EXAMPLE'],
      n: 42,
    };
    const out = redactSecrets(input) as typeof input;
    expect(out.tool).toBe('send_email');
    expect(out.args.to).toBe('a@b.com');
    expect(out.args.note).not.toContain('sk-ABCDEFGHIJKLMNOP');
    expect(out.args.note).toContain('***REDACTED***');
    expect(out.list[0]).toBe('plain');
    expect(out.list[1]).toContain('AWS_KEY_REDACTED');
    expect(out.n).toBe(42);
  });

  it('redacts values under credential-named keys regardless of content/casing', () => {
    const out = redactSecrets({
      Authorization: 'Bearer xy',          // too short for the Bearer pattern
      password: 'hunter2',                 // opaque, no recognizable pattern
      customSecret: 'whatever',
      apiKey: 'short',
      normalField: 'keep me',
      nested: { Cookie: 'session=abc' },
    }) as Record<string, any>;
    expect(out.Authorization).toBe('***REDACTED***');
    expect(out.password).toBe('***REDACTED***');
    expect(out.customSecret).toBe('***REDACTED***');
    expect(out.apiKey).toBe('***REDACTED***');
    expect(out.normalField).toBe('keep me');
    expect(out.nested.Cookie).toBe('***REDACTED***');
  });

  it('does not redact (or retype) non-string values under credential-named keys', () => {
    const out = redactSecrets({
      hasPassword: true,
      topSecret: false,
      csrfToken: 12345,
      tokenCount: 7,        // not a credential suffix, kept anyway
      maxTokens: 4096,
    }) as Record<string, any>;
    expect(out.hasPassword).toBe(true);
    expect(out.topSecret).toBe(false);
    expect(out.csrfToken).toBe(12345);
    expect(out.tokenCount).toBe(7);
    expect(out.maxTokens).toBe(4096);
  });

  it('fails closed past the depth cap and on cycles (no raw secret leaks through)', () => {
    // Nest a secret deeper than the depth cap (12).
    let deep: any = { password: 'hunter2deepsecret' };
    for (let i = 0; i < 20; i++) deep = { wrap: deep };
    const out = JSON.stringify(redactSecrets(deep));
    expect(out).not.toContain('hunter2deepsecret');
    // A cyclic structure is rendered safe (serializable, no throw).
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => JSON.stringify(redactSecrets(a))).not.toThrow();
  });

  it('leaves Error / Date / Buffer / Map / Set / typed arrays / class instances intact', () => {
    const err = new Error('boom');
    expect(redactSecrets(err)).toBe(err);
    const d = new Date();
    expect(redactSecrets(d)).toBe(d);
    const buf = Buffer.from('x');
    expect(Buffer.isBuffer(redactSecrets(buf))).toBe(true);
    const map = new Map([['k', 'v']]);
    expect(redactSecrets(map)).toBe(map);
    const set = new Set([1, 2]);
    expect(redactSecrets(set)).toBe(set);
    const ta = new Uint8Array([1, 2, 3]);
    expect(redactSecrets(ta)).toBe(ta);
    class Foo { constructor(public x = 1) {} }
    const foo = new Foo();
    expect(redactSecrets(foo)).toBe(foo);
  });

  it('does not hang on circular references', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => redactSecrets(a)).not.toThrow();
  });
});

describe('createStreamingRedactor (#185)', () => {
  function run(deltas: string[]): string {
    const out: string[] = [];
    const r = createStreamingRedactor((c) => out.push(c));
    for (const d of deltas) r.push(d);
    r.flush();
    return out.join('');
  }

  // Feed `text` in chunks of `size` and capture everything emitted BEFORE flush.
  function liveBeforeFlush(text: string, size: number): string {
    const out: string[] = [];
    const r = createStreamingRedactor((c) => out.push(c));
    for (let i = 0; i < text.length; i += size) r.push(text.slice(i, i + size));
    const live = out.join('');
    r.flush();
    return live;
  }

  it('passes normal text through unchanged', () => {
    expect(run(['Hello ', 'world', '!'])).toBe('Hello world!');
  });

  it('redacts a secret that arrives whole', () => {
    const out = run(['my key is sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 ok']);
    expect(out).not.toContain('sk-ABCDEFGHIJKLMNOP');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts a secret split across multiple deltas', () => {
    const out = run(['here: sk-', 'ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ0123', '45 end']);
    expect(out).not.toContain('sk-ABCDEFGHIJKLMNOP');
    expect(out).toContain('***REDACTED***');
    expect(out).toContain('here:');
    expect(out).toContain('end');
  });

  it('never leaks a JWT longer than the holdback while it streams', () => {
    const header = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const payload = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImV4dHJhIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSJ9';
    const sig = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const jwt = `${header}.${payload}.${sig}`;
    // Stream one char at a time — the whole header + payload exceed the holdback.
    const live = liveBeforeFlush(`token ${jwt} end`, 1);
    expect(live).not.toContain(header);
    expect(live).not.toContain('eyJzdWIiOiIxMjM0');
    // And the complete stream redacts the JWT.
    const full = run([`token ${jwt} end`]);
    expect(full).toContain('***JWT_REDACTED***');
    expect(full).not.toContain(header);
  });

  it('never emits the contents of an unterminated private-key block early', () => {
    const out: string[] = [];
    const r = createStreamingRedactor((c) => out.push(c));
    r.push('-----BEGIN PRIVATE KEY-----\n');
    r.push('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ' + 'A'.repeat(400) + '\n');
    expect(out.join('')).not.toContain('MIIEvQ');
    r.push('-----END PRIVATE KEY-----\n');
    r.flush();
    expect(out.join('')).toContain('***PRIVATE_KEY_REDACTED***');
    expect(out.join('')).not.toContain('MIIEvQ');
  });

  it('flush releases the held-back tail', () => {
    expect(run(['short tail'])).toBe('short tail');
  });

  it('buffer trimming preserves output exactly on long text (equivalence with filterOutput)', () => {
    // Long text well past the trim threshold, with secrets sprinkled throughout
    // at positions that will straddle trim boundaries.
    let text = '';
    for (let i = 0; i < 60; i++) {
      text += `paragraph ${i} with some filler words to push past the trim threshold. `;
      if (i % 7 === 0) text += `secret sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ${i}00000 here. `;
    }
    // Stream in small random-ish chunks and compare to a single-shot filterOutput.
    const chunked = run(Array.from({ length: Math.ceil(text.length / 5) }, (_, i) => text.slice(i * 5, i * 5 + 5)));
    expect(chunked).toBe(filterOutput(text));
    expect(chunked).not.toMatch(/sk-ABCDEFGHIJKLMNOP/);
  });

  it('never leaks the body of a COMPLETED PEM block larger than the trim threshold', () => {
    // RSA-key-sized body (~2KB) — well past TRIM_THRESHOLD/RETAIN, so the trim
    // path runs while the (now complete) block is in the buffer.
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(60);
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    const text = `here is your key: ${pem} done`;
    const chunked = run(Array.from({ length: Math.ceil(text.length / 5) }, (_, i) => text.slice(i * 5, i * 5 + 5)));
    expect(chunked).not.toContain('MIIEvQ');
    expect(chunked).not.toContain(body.slice(50, 90));
    expect(chunked).toContain('***PRIVATE_KEY_REDACTED***');
    expect(chunked).toBe(filterOutput(text));
  });

  it('never leaks the body of a COMPLETED long JWT streamed past the threshold', () => {
    const header = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const payload = 'eyJ' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.repeat(40);
    const sig = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const text = `tok ${header}.${payload}.${sig} end`;
    const chunked = run(Array.from({ length: Math.ceil(text.length / 7) }, (_, i) => text.slice(i * 7, i * 7 + 7)));
    expect(chunked).not.toContain(payload.slice(10, 60));
    expect(chunked).toContain('***JWT_REDACTED***');
    expect(chunked).toBe(filterOutput(text));
  });

  it('redacts and bounds an UNTERMINATED PEM block (no leak, no unbounded buffer)', () => {
    const out: string[] = [];
    const r = createStreamingRedactor((c) => out.push(c));
    r.push('your key: -----BEGIN PRIVATE KEY-----\n');
    for (let i = 0; i < 5000; i++) r.push('ABCDEFGHIJ'); // 50k chars, never terminated
    const live = out.join('');
    expect(live).not.toContain('ABCDEFGHIJABCDEFGHIJ');
    expect(live).toContain('***PRIVATE_KEY_REDACTED***');
    r.flush();
    // After the marker, the discarded body never surfaces.
    expect(out.join('')).not.toContain('ABCDEFGHIJABCDEFGHIJ');
  });

  it('resumes normal output after a capped oversized secret terminates', () => {
    const out: string[] = [];
    const r = createStreamingRedactor((c) => out.push(c));
    r.push('-----BEGIN PRIVATE KEY-----\n');
    for (let i = 0; i < 2000; i++) r.push('ABCDEFGHIJ'); // exceed ceiling → capped
    r.push('\n-----END PRIVATE KEY-----\nafterwards the answer continues here.');
    r.flush();
    const joined = out.join('');
    expect(joined).toContain('***PRIVATE_KEY_REDACTED***');
    expect(joined).toContain('afterwards the answer continues here.');
    expect(joined).not.toContain('ABCDEFGHIJABCDEFGHIJ');
  });

  it('does not duplicate or drop output when a redaction precedes a long tail', () => {
    // A redaction early (shrinks filtered length) followed by lots of text that
    // forces trims — exercises the emitted-accounting after trim.
    const text = 'key sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 then ' + 'lorem ipsum dolor sit amet '.repeat(80);
    const chunked = run(Array.from({ length: Math.ceil(text.length / 3) }, (_, i) => text.slice(i * 3, i * 3 + 3)));
    expect(chunked).toBe(filterOutput(text));
  });
});
