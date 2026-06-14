/**
 * #36 — scope keys must never let a filesystem operation escape the scopes/
 * directory, including during the DB-driven migration where keys come from
 * attacker-influenceable sender ids.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isSafeScopeKey, resolveScopedFile, getScopedMemoryDir, ensureScopeDir, migrateScopesToUserUUID,
} from '../scope.js';

let ws: string;
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-')); });
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

describe('isSafeScopeKey', () => {
  it('accepts normal keys', () => {
    for (const k of ['abc-uuid-123', 'telegram:12345', 'group_web_room1', 'a.b_c@d']) {
      expect(isSafeScopeKey(k)).toBe(true);
    }
  });
  it('rejects traversal / separators / null bytes / empty', () => {
    for (const k of ['../etc', 'a/b', 'a\\b', '..', '.', 'x\0y', '']) {
      expect(isSafeScopeKey(k)).toBe(false);
    }
  });
});

describe('live scope path functions reject unsafe keys', () => {
  it('resolveScopedFile falls back to global for an unsafe key', () => {
    expect(resolveScopedFile(ws, 'PROFILE.md', '../../evil')).toBe(path.join(ws, 'PROFILE.md'));
  });
  it('getScopedMemoryDir throws on an unsafe key (no silent global fallback)', () => {
    expect(() => getScopedMemoryDir(ws, '../../evil')).toThrow(/unsafe/i);
    expect(getScopedMemoryDir(ws, 'uuid-1')).toBe(path.join(ws, 'scopes', 'uuid-1', 'memory'));
  });
  it('ensureScopeDir throws on an unsafe key and creates nothing', () => {
    expect(() => ensureScopeDir(ws, '../../evil')).toThrow(/unsafe/i);
    expect(fs.existsSync(path.join(ws, 'scopes'))).toBe(false);
  });
});

describe('migrateScopesToUserUUID', () => {
  const mockDb = (rows: unknown[]) => ({ query: async () => rows } as any);

  it('migrates a valid legacy scope to the user UUID', async () => {
    const scopes = path.join(ws, 'scopes');
    const oldDir = path.join(scopes, 'telegram:123', 'memory');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'PROFILE.md'), 'hi');

    const res = await migrateScopesToUserUUID(ws, mockDb([
      { channel_type: 'telegram', sender_id: '123', user_id: 'uuid-1' },
    ]));

    expect(res.migrated).toBe(1);
    expect(fs.existsSync(path.join(scopes, 'uuid-1', 'memory', 'PROFILE.md'))).toBe(true);
    expect(fs.existsSync(path.join(scopes, 'telegram:123'))).toBe(false);
  });

  it('skips a malicious sender_id and never deletes outside scopes/', async () => {
    const scopes = path.join(ws, 'scopes');
    fs.mkdirSync(scopes, { recursive: true });
    // Sentinel dir OUTSIDE scopes that a traversal would target.
    const sentinel = path.join(ws, 'sentinel');
    fs.mkdirSync(sentinel, { recursive: true });
    fs.writeFileSync(path.join(sentinel, 'keep.txt'), 'precious');

    const res = await migrateScopesToUserUUID(ws, mockDb([
      { channel_type: 'telegram', sender_id: '../../sentinel', user_id: 'uuid-x' },
      { channel_type: 'telegram', sender_id: '999', user_id: '../../../sentinel' },
    ]));

    expect(res.migrated).toBe(0);
    expect(res.skipped).toBe(2);
    expect(fs.existsSync(path.join(sentinel, 'keep.txt'))).toBe(true);
  });
});
