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
});
