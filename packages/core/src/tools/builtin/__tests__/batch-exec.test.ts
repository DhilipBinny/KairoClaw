import { describe, it, expect } from 'vitest';
import { execTools } from '../exec.js';

const batchExec = execTools.find(t => t.definition.name === 'batch_exec')!;

// ─── validateInput ──────────────────────────────────────────────────

describe('batch_exec — validateInput', () => {
  const validate = batchExec.validateInput!;

  it('rejects empty array', () => {
    const r = validate({ commands: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects > 10 commands', () => {
    const cmds = Array.from({ length: 11 }, (_, i) => `echo ${i}`);
    const r = validate({ commands: cmds });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/10/);
  });

  it('rejects non-string commands', () => {
    const r = validate({ commands: [123, null] });
    expect(r.ok).toBe(false);
  });

  it('accepts valid array of 1-10 strings', () => {
    const r = validate({ commands: ['echo hello', 'echo world'] });
    expect(r.ok).toBe(true);
  });
});

// ─── executor ───────────────────────────────────────────────────────

describe('batch_exec — executor', () => {
  const context = { config: { agent: { workspace: '/tmp' } } } as any;

  it('single command: echo hello', async () => {
    const result = await batchExec.executor({ commands: ['echo hello'] }, context);
    const text = (result as any).content[0].text;
    expect(text).toContain('hello');
    expect(text).toContain('exit code: 0');
  });

  it('multiple parallel commands', async () => {
    const result = await batchExec.executor({ commands: ['echo a', 'echo b'] }, context);
    const text = (result as any).content[0].text;
    expect(text).toContain('a');
    expect(text).toContain('b');
    expect(text).toMatch(/2 commands/);
  });

  it('failed command shows exit code 1', async () => {
    const result = await batchExec.executor({ commands: ['exit 1'] }, context);
    const text = (result as any).content[0].text;
    expect(text).toContain('exit code: 1');
  });
});
