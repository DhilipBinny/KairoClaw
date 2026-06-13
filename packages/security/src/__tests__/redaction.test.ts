import { describe, it, expect } from 'vitest';
import { filterOutput, containsSecrets, redactSecrets, createStreamingRedactor } from '../output.js';

describe('filterOutput — added secret patterns (#185)', () => {
  it('redacts a Telegram bot token', () => {
    const out = filterOutput('bot=123456789:AAH-dummytoken_ABCDEFGHIJKLMNOPqrstuv done');
    expect(out).not.toContain('AAH-dummytoken');
    expect(out).toContain('***TELEGRAM_TOKEN_REDACTED***');
    expect(out).toContain('done');
  });

  it('redacts a Brave Search API key', () => {
    const out = filterOutput('key BSA1234567890abcdefABCDEF_xyz end');
    expect(out).not.toContain('BSA1234567890abcdefABCDEF');
    expect(out).toContain('***BRAVE_KEY_REDACTED***');
  });

  it('redacts the master key only in its env/file-name context', () => {
    const out = filterOutput('AGW_MASTER_KEY=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3OA==');
    expect(out).toContain('AGW_MASTER_KEY=***REDACTED***');
    expect(out).not.toContain('YWJjZGVm');
  });

  it('does not redact a bare base64 blob in normal output (no master-key false positives)', () => {
    const blob = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3OA==';
    expect(filterOutput(`here is the data: ${blob}`)).toContain(blob);
  });

  it('containsSecrets reflects the new patterns', () => {
    expect(containsSecrets('123456789:AAH-dummytoken_ABCDEFGHIJKLMNOPqrstuv')).toBe(true);
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

  it('leaves Error instances intact (preserves stack/serialization)', () => {
    const err = new Error('boom');
    expect(redactSecrets(err)).toBe(err);
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

  it('passes normal text through unchanged', () => {
    expect(run(['Hello ', 'world', '!'])).toBe('Hello world!');
  });

  it('redacts a secret that arrives whole', () => {
    const out = run(['my key is sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 ok']);
    expect(out).not.toContain('sk-ABCDEFGHIJKLMNOP');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts a secret split across multiple deltas', () => {
    // The token is fragmented exactly the way a token stream would split it.
    const out = run(['here: sk-', 'ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ0123', '45 end']);
    expect(out).not.toContain('sk-ABCDEFGHIJKLMNOP');
    expect(out).toContain('***REDACTED***');
    expect(out).toContain('here:');
    expect(out).toContain('end');
  });

  it('never emits the contents of an unterminated private-key block early', () => {
    const out: string[] = [];
    const r = createStreamingRedactor((c) => out.push(c));
    r.push('-----BEGIN PRIVATE KEY-----\n');
    r.push('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ' + 'A'.repeat(200) + '\n');
    // Before the END marker, nothing of the key may have been released.
    expect(out.join('')).not.toContain('MIIEvQ');
    r.push('-----END PRIVATE KEY-----\n');
    r.flush();
    expect(out.join('')).toContain('***PRIVATE_KEY_REDACTED***');
    expect(out.join('')).not.toContain('MIIEvQ');
  });

  it('flush releases the held-back tail', () => {
    const out: string[] = [];
    const r = createStreamingRedactor((c) => out.push(c));
    r.push('short tail');
    r.flush();
    expect(out.join('')).toBe('short tail');
  });
});
