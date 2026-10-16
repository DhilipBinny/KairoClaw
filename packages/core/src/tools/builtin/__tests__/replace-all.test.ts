import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileTools } from '@agw/tools-common';

const editFile = fileTools.find(t => t.definition.name === 'edit_file')!;

// realpathSync canonicalizes the temp dir so the path-safety symlink check
// compares like-for-like — on macOS /tmp and os.tmpdir() are themselves
// symlinks (→ /private/...), which would otherwise trip the guard. No-op on
// Linux, so the test passes on any dev environment.
let TMP_DIR: string;
let testFile: string;

function makeContext() {
  return {
    scopeKey: null,
    config: { agent: { workspace: TMP_DIR } },
    fileState: {
      recordRead: () => {},
      recordWrite: () => {},
      requireRead: (_p: string) => ({ ok: true }),
    },
  } as any;
}

beforeEach(() => {
  TMP_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-test-replace-all-')));
  testFile = path.join(TMP_DIR, 'test.txt');
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('edit_file — replace_all', () => {
  it('replace_all=true replaces all occurrences', async () => {
    fs.writeFileSync(testFile, 'foo bar foo baz foo');
    const ctx = makeContext();

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
    const ctx = makeContext();

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
    const ctx = makeContext();

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
