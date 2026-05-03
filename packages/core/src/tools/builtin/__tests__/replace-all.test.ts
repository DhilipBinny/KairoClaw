import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileTools } from '../files.js';

const editFile = fileTools.find(t => t.definition.name === 'edit_file')!;

const TMP_DIR = `/tmp/kairo-test-replace-all-${Date.now()}`;
let testFile: string;

function makeContext(filePath: string) {
  return {
    scopeKey: null,
    config: { agent: { workspace: '/tmp' } },
    fileState: {
      recordRead: () => {},
      recordWrite: () => {},
      requireRead: (p: string) => ({ ok: true }),
    },
  } as any;
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  testFile = path.join(TMP_DIR, 'test.txt');
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('edit_file — replace_all', () => {
  it('replace_all=true replaces all occurrences', async () => {
    fs.writeFileSync(testFile, 'foo bar foo baz foo');
    const ctx = makeContext(testFile);

    const result = await editFile.executor(
      { path: testFile, old_string: 'foo', new_string: 'qux', replace_all: true },
      ctx,
    );

    const content = fs.readFileSync(testFile, 'utf8');
    expect(content).toBe('qux bar qux baz qux');
    const text = (result as any).content[0].text;
    expect(text).toMatch(/3 occurrences/);
  });

  it('replace_all=false (default) rejects when old_string matches multiple times', async () => {
    fs.writeFileSync(testFile, 'foo bar foo baz foo');
    const ctx = makeContext(testFile);

    const result = await editFile.executor(
      { path: testFile, old_string: 'foo', new_string: 'qux' },
      ctx,
    );

    expect((result as any).error).toMatch(/matches more than once/);
    // File should not be modified
    const content = fs.readFileSync(testFile, 'utf8');
    expect(content).toBe('foo bar foo baz foo');
  });

  it('replace_all=true with single occurrence works and says "1 occurrence"', async () => {
    fs.writeFileSync(testFile, 'hello world');
    const ctx = makeContext(testFile);

    const result = await editFile.executor(
      { path: testFile, old_string: 'hello', new_string: 'goodbye', replace_all: true },
      ctx,
    );

    const content = fs.readFileSync(testFile, 'utf8');
    expect(content).toBe('goodbye world');
    const text = (result as any).content[0].text;
    expect(text).toMatch(/1 occurrence/);
  });
});
