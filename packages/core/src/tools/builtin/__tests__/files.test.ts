import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { safePath, scopedSafePath } from '../files.js';

// Create a temp workspace for each test
let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-test-'));
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

  it('allows /tmp', () => {
    const result = safePath('/tmp/test.txt', workspace);
    expect(result).toBe('/tmp/test.txt');
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
  const _userBCtx = { user: { role: 'user' }, scopeKey: 'user-b-uuid' };
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
