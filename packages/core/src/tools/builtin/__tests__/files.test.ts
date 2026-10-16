import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { safePath, scopedSafePath, fileTools } from '@agw/tools-common';
import { FileStateTracker } from '../../../agent/file-state.js';

// Create a temp workspace for each test
let workspace: string;

beforeEach(() => {
  // realpathSync canonicalizes the temp dir so the path-safety symlink check
  // compares like-for-like — on macOS os.tmpdir() is itself a symlink
  // (→ /private/var/...), which would otherwise trip the guard. No-op on Linux.
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-test-')));
  fs.mkdirSync(path.join(workspace, 'scopes', 'user-a-uuid', 'documents'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'scopes', 'user-b-uuid', 'documents'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'scopes', 'group_telegram_-100123', 'memory'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'shared', 'documents'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'documents'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'IDENTITY.md'), 'test');
  fs.writeFileSync(path.join(workspace, 'scopes', 'user-a-uuid', 'documents', 'secret.md'), 'user A data');
  fs.writeFileSync(path.join(workspace, 'scopes', 'user-b-uuid', 'documents', 'private.md'), 'user B data');
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

// ── safePath ──────────────────────────────────────────────

describe('safePath', () => {
  it('resolves relative paths against workspace', () => {
    const result = safePath('docs/file.md', workspace);
    expect(result).toBe(path.join(workspace, 'docs/file.md'));
  });

  it('blocks null bytes', () => {
    expect(() => safePath('file\0.md', workspace)).toThrow('null bytes');
  });

  it('blocks control characters', () => {
    expect(() => safePath('file\x01.md', workspace)).toThrow('control characters');
  });

  it('blocks path traversal outside workspace', () => {
    expect(() => safePath('../../etc/passwd', workspace)).toThrow('outside allowed');
  });

  it('blocks absolute path outside workspace', () => {
    expect(() => safePath('/etc/passwd', workspace)).toThrow('outside allowed');
  });

  it('blocks /tmp (no longer allowed)', () => {
    expect(() => safePath('/tmp/test.txt', workspace)).toThrow('outside allowed');
  });

  it('allows workspace subdirectories', () => {
    const result = safePath('scopes/user-a-uuid/documents/file.md', workspace);
    expect(result).toBe(path.join(workspace, 'scopes/user-a-uuid/documents/file.md'));
  });
});

// ── scopedSafePath ────────────────────────────────────────

describe('scopedSafePath', () => {
  const adminCtx = { user: { role: 'admin' }, scopeKey: null };
  const userACtx = { user: { role: 'user' }, scopeKey: 'user-a-uuid' };
  const unscopedCtx = { user: { role: 'user' }, scopeKey: null };

  // Admin — unrestricted
  it('admin can access any scope', () => {
    const result = scopedSafePath('scopes/user-b-uuid/documents/private.md', workspace, adminCtx);
    expect(result).toBe(path.join(workspace, 'scopes/user-b-uuid/documents/private.md'));
  });

  it('admin can list scopes/ root', () => {
    const result = scopedSafePath('scopes', workspace, adminCtx);
    expect(result).toBe(path.join(workspace, 'scopes'));
  });

  // User — own scope allowed
  it('user can access own scope', () => {
    const result = scopedSafePath('scopes/user-a-uuid/documents/secret.md', workspace, userACtx);
    expect(result).toBe(path.join(workspace, 'scopes/user-a-uuid/documents/secret.md'));
  });

  // User — other scope blocked
  it('user CANNOT access other user scope', () => {
    expect(() => scopedSafePath('scopes/user-b-uuid/documents/private.md', workspace, userACtx))
      .toThrow('cannot access other users');
  });

  it('user CANNOT list scopes/ root', () => {
    expect(() => scopedSafePath('scopes', workspace, userACtx))
      .toThrow('cannot list other users');
  });

  // User — shared files allowed
  it('user can access shared/documents', () => {
    const result = scopedSafePath('shared/documents/report.md', workspace, userACtx);
    expect(result).toBe(path.join(workspace, 'shared/documents/report.md'));
  });

  it('user can access persona files', () => {
    const result = scopedSafePath('IDENTITY.md', workspace, userACtx);
    expect(result).toBe(path.join(workspace, 'IDENTITY.md'));
  });

  // Unscoped user — blocked from all scopes
  it('unscoped user CANNOT access any scope', () => {
    expect(() => scopedSafePath('scopes/user-a-uuid/documents/secret.md', workspace, unscopedCtx))
      .toThrow('cannot access other users');
  });

  it('unscoped user can access shared files', () => {
    const result = scopedSafePath('shared/documents/report.md', workspace, unscopedCtx);
    expect(result).toBe(path.join(workspace, 'shared/documents/report.md'));
  });

  // Group scope
  it('user CANNOT access group scope unless it is their scopeKey', () => {
    expect(() => scopedSafePath('scopes/group_telegram_-100123/memory/PROFILE.md', workspace, userACtx))
      .toThrow('cannot access other users');
  });
});

// ── Read-before-edit enforcement (Phase 6.3) ─────────────
//
// Tests the FileStateTracker integration in read_file / write_file /
// edit_file. The contract: edit_file refuses to run on a path that
// hasn't been read in this session OR whose on-disk content has
// changed since the last read.

const readFileTool = fileTools.find(t => t.definition.name === 'read_file')!;
const writeFileTool = fileTools.find(t => t.definition.name === 'write_file')!;
const editFileTool = fileTools.find(t => t.definition.name === 'edit_file')!;

function ctxWithTracker(tracker: FileStateTracker, ws: string) {
  // Cast through unknown — the test exercises the executor end-to-end
  // and the runtime context only needs `fileState`, `scopeKey`,
  // `user`, and the workspace via `(context as any).config.agent.workspace`.
  return {
    fileState: tracker,
    scopeKey: null,
    user: { id: 'admin', role: 'admin', elevated: true },
    config: { agent: { workspace: ws } },
  } as unknown as Parameters<typeof readFileTool.executor>[1];
}

describe('edit_file read-before-edit enforcement', () => {
  let tracker: FileStateTracker;
  let target: string;

  beforeEach(() => {
    tracker = new FileStateTracker();
    target = path.join(workspace, 'documents', 'note.md');
    fs.writeFileSync(target, 'hello world\nsecond line\n');
  });

  it('rejects edit_file when the path has not been read yet', async () => {
    const ctx = ctxWithTracker(tracker, workspace);
    const result = await editFileTool.executor(
      { path: 'documents/note.md', old_string: 'hello world', new_string: 'goodbye world' },
      ctx,
    );
    expect((result as { error?: string }).error).toMatch(/not read yet/i);
    // File on disk must be untouched
    expect(fs.readFileSync(target, 'utf8')).toBe('hello world\nsecond line\n');
  });

  it('succeeds after read_file on the same path in the session', async () => {
    const ctx = ctxWithTracker(tracker, workspace);
    await readFileTool.executor({ path: 'documents/note.md' }, ctx);
    const result = await editFileTool.executor(
      { path: 'documents/note.md', old_string: 'hello world', new_string: 'goodbye world' },
      ctx,
    );
    expect((result as { error?: string }).error).toBeUndefined();
    expect(fs.readFileSync(target, 'utf8')).toBe('goodbye world\nsecond line\n');
  });

  it('rejects edit_file when the file changed on disk since the read', async () => {
    const ctx = ctxWithTracker(tracker, workspace);
    await readFileTool.executor({ path: 'documents/note.md' }, ctx);
    // Out-of-band write — bypasses the tracker
    fs.writeFileSync(target, 'tampered content\n');
    const result = await editFileTool.executor(
      { path: 'documents/note.md', old_string: 'hello world', new_string: 'goodbye world' },
      ctx,
    );
    expect((result as { error?: string }).error).toMatch(/changed on disk/i);
    // Tampered content must remain — the edit is rejected before any I/O
    expect(fs.readFileSync(target, 'utf8')).toBe('tampered content\n');
  });

  it('write_file counts as a read so a follow-up edit_file works', async () => {
    const ctx = ctxWithTracker(tracker, workspace);
    const newTarget = 'documents/fresh.md';
    await writeFileTool.executor({ path: newTarget, content: 'foo bar baz\n' }, ctx);
    const result = await editFileTool.executor(
      { path: newTarget, old_string: 'foo bar baz', new_string: 'updated text' },
      ctx,
    );
    expect((result as { error?: string }).error).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, newTarget), 'utf8')).toBe('updated text\n');
  });

  it('partial read with offset/limit still satisfies the edit guard for the whole file', async () => {
    // Big file so a partial read returns only some lines, but the
    // tracker hashes the full content (so subsequent edits compare
    // against the same on-disk state the reader actually saw).
    const longLines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    fs.writeFileSync(target, longLines);

    const ctx = ctxWithTracker(tracker, workspace);
    await readFileTool.executor(
      { path: 'documents/note.md', offset: 1, limit: 5 },
      ctx,
    );
    const result = await editFileTool.executor(
      { path: 'documents/note.md', old_string: 'line 25', new_string: 'LINE 25' },
      ctx,
    );
    expect((result as { error?: string }).error).toBeUndefined();
    const after = fs.readFileSync(target, 'utf8');
    expect(after).toContain('LINE 25');
    expect(after).not.toContain('line 25');
  });
});
