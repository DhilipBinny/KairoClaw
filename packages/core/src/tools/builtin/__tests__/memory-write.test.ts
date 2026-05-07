import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  appendProfileEntry,
  readPinned,
  writePinned,
  forgetById,
  memoryWriteTools,
} from '../memory-write.js';

const memoryWrite = memoryWriteTools.find(t => t.definition.name === 'memory_write')!;
const memoryPin = memoryWriteTools.find(t => t.definition.name === 'memory_pin')!;
const memoryForget = memoryWriteTools.find(t => t.definition.name === 'memory_forget')!;

let tmpDir: string;
let memoryDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-test-'));
  memoryDir = path.join(tmpDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── appendProfileEntry ─────���───────────────────────────────

describe('appendProfileEntry', () => {
  it('creates PROFILE.md and returns 8-char hex id', () => {
    const id = appendProfileEntry(memoryDir, 'Test fact');
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const content = fs.readFileSync(path.join(memoryDir, 'PROFILE.md'), 'utf8');
    expect(content).toContain(`id:${id}`);
    expect(content).toContain('Test fact');
    expect(content).toContain('## Note');
  });

  it('appends multiple entries without overwriting', () => {
    appendProfileEntry(memoryDir, 'First');
    appendProfileEntry(memoryDir, 'Second');
    const content = fs.readFileSync(path.join(memoryDir, 'PROFILE.md'), 'utf8');
    expect(content).toContain('First');
    expect(content).toContain('Second');
  });
});

// ─── readPinned / writePinned ───────────────────────────────

describe('readPinned / writePinned', () => {
  it('returns empty array when PINNED.md does not exist', () => {
    expect(readPinned(memoryDir)).toEqual([]);
  });

  it('round-trips entries correctly', () => {
    const entries = [
      { id: 'aabbccdd', ts: '2025-01-01T00:00:00.000Z', content: 'User prefers short replies' },
      { id: '11223344', ts: '2025-01-02T00:00:00.000Z', content: 'Always use pnpm' },
    ];
    writePinned(memoryDir, entries);
    const read = readPinned(memoryDir);
    expect(read).toHaveLength(2);
    expect(read[0].id).toBe('aabbccdd');
    expect(read[0].content).toBe('User prefers short replies');
    expect(read[1].id).toBe('11223344');
  });
});

// ─── forgetById ─────────────���────────────────���──────────────

describe('forgetById', () => {
  it('removes a profile entry by id', () => {
    const id = appendProfileEntry(memoryDir, 'To be deleted');
    appendProfileEntry(memoryDir, 'To be kept');
    const { changed, details } = forgetById(memoryDir, id);
    expect(changed).toBe(1);
    expect(details[0]).toContain('removed 1 profile block');
    const content = fs.readFileSync(path.join(memoryDir, 'PROFILE.md'), 'utf8');
    expect(content).not.toContain('To be deleted');
    expect(content).toContain('To be kept');
  });

  it('removes a pinned entry by id', () => {
    writePinned(memoryDir, [
      { id: 'aabbccdd', ts: '2025-01-01T00:00:00.000Z', content: 'Keep this' },
      { id: '11223344', ts: '2025-01-02T00:00:00.000Z', content: 'Remove this' },
    ]);
    const { changed, details } = forgetById(memoryDir, '11223344');
    expect(changed).toBe(1);
    expect(details[0]).toContain('removed 1 pinned');
    const remaining = readPinned(memoryDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('aabbccdd');
  });

  it('returns changed=0 when id not found', () => {
    appendProfileEntry(memoryDir, 'Something');
    const { changed } = forgetById(memoryDir, 'deadbeef');
    expect(changed).toBe(0);
  });
});

// ─── memory_write executor ────────────────────��─────────────

describe('memory_write — executor', () => {
  const ctx = (scopeKey?: string) => ({
    config: { agent: { workspace: tmpDir } },
    scopeKey: scopeKey ?? null,
  }) as any;

  it('writes to unscoped memory dir', async () => {
    const result = await memoryWrite.executor({ content: 'Remember this' }, ctx());
    const text = (result as any).content[0].text;
    expect(text).toContain('Saved to PROFILE.md');
    expect(text).toMatch(/id [0-9a-f]{8}/);
    expect(fs.existsSync(path.join(tmpDir, 'memory', 'PROFILE.md'))).toBe(true);
  });

  it('writes to scoped memory dir', async () => {
    const result = await memoryWrite.executor({ content: 'Scoped fact' }, ctx('user123'));
    expect((result as any).content[0].text).toContain('Saved');
    expect(fs.existsSync(path.join(tmpDir, 'scopes', 'user123', 'memory', 'PROFILE.md'))).toBe(true);
  });

  it('rejects empty content', async () => {
    const result = await memoryWrite.executor({ content: '  ' }, ctx());
    expect((result as any).error).toContain('non-empty string');
  });

  it('blocks regular user in group scope', async () => {
    const groupCtx = { config: { agent: { workspace: tmpDir } }, scopeKey: 'group_123', user: { role: 'user' } } as any;
    const result = await memoryWrite.executor({ content: 'Poisoned memory' }, groupCtx);
    expect((result as any).error).toContain('admin or power_user');
  });

  it('allows admin in group scope', async () => {
    const groupCtx = { config: { agent: { workspace: tmpDir } }, scopeKey: 'group_123', user: { role: 'admin' } } as any;
    const result = await memoryWrite.executor({ content: 'Admin note' }, groupCtx);
    expect((result as any).content[0].text).toContain('Saved');
  });
});

// ─── memory_pin executor ────────────────────────────────────

describe('memory_pin — executor', () => {
  const ctx = () => ({
    config: { agent: { workspace: tmpDir } },
    scopeKey: null,
  }) as any;

  it('pins a note and reports count', async () => {
    const result = await memoryPin.executor({ content: 'Use pnpm' }, ctx());
    const text = (result as any).content[0].text;
    expect(text).toContain('Pinned with id');
    expect(text).toContain('1/5');
    const entries = readPinned(path.join(tmpDir, 'memory'));
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Use pnpm');
  });

  it('drops oldest when exceeding cap', async () => {
    for (let i = 0; i < 5; i++) {
      await memoryPin.executor({ content: `Pin ${i}` }, ctx());
    }
    const result = await memoryPin.executor({ content: 'Pin 5 (overflow)' }, ctx());
    const text = (result as any).content[0].text;
    expect(text).toContain('Dropped oldest pin');
    expect(text).toContain('5/5');
    const entries = readPinned(path.join(tmpDir, 'memory'));
    expect(entries).toHaveLength(5);
    expect(entries[0].content).toBe('Pin 1');
    expect(entries[4].content).toBe('Pin 5 (overflow)');
  });

  it('collapses multi-line content to single line', async () => {
    await memoryPin.executor({ content: 'Line 1\nLine 2\n  Line 3' }, ctx());
    const entries = readPinned(path.join(tmpDir, 'memory'));
    expect(entries[0].content).toBe('Line 1 Line 2 Line 3');
  });

  it('rejects empty content', async () => {
    const result = await memoryPin.executor({ content: '' }, ctx());
    expect((result as any).error).toContain('non-empty string');
  });

  it('blocks regular user in group scope', async () => {
    const groupCtx = { config: { agent: { workspace: tmpDir } }, scopeKey: 'group_456', user: { role: 'user' } } as any;
    const result = await memoryPin.executor({ content: 'Poisoned pin' }, groupCtx);
    expect((result as any).error).toContain('admin or power_user');
  });

  it('allows power_user in group scope', async () => {
    const groupCtx = { config: { agent: { workspace: tmpDir } }, scopeKey: 'group_456', user: { role: 'power_user' } } as any;
    const result = await memoryPin.executor({ content: 'Power user pin' }, groupCtx);
    expect((result as any).content[0].text).toContain('Pinned');
  });
});

// ─── memory_forget executor ─────────────────────────────────

describe('memory_forget — executor', () => {
  const ctx = () => ({
    config: { agent: { workspace: tmpDir } },
    scopeKey: null,
  }) as any;

  it('validates id format', async () => {
    const result = await memoryForget.executor({ id: 'not-hex' }, ctx());
    expect((result as any).error).toContain('8-character hex');
  });

  it('reports "nothing to remove" when memory dir missing', async () => {
    // Use a fresh dir without memory subdir
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-fresh-'));
    const freshCtx = { config: { agent: { workspace: freshDir } }, scopeKey: null } as any;
    const result = await memoryForget.executor({ id: 'aabbccdd' }, freshCtx);
    expect((result as any).content[0].text).toContain('nothing to remove');
    fs.rmSync(freshDir, { recursive: true, force: true });
  });

  it('deletes a previously written entry', async () => {
    const writeResult = await memoryWrite.executor({ content: 'Temp note' }, ctx());
    const id = (writeResult as any).content[0].text.match(/id ([0-9a-f]{8})/)[1];

    const forgetResult = await memoryForget.executor({ id }, ctx());
    expect((forgetResult as any).content[0].text).toContain('removed 1 profile block');

    const profile = fs.readFileSync(path.join(tmpDir, 'memory', 'PROFILE.md'), 'utf8');
    expect(profile).not.toContain('Temp note');
  });

  it('deletes a pinned entry', async () => {
    const pinResult = await memoryPin.executor({ content: 'Temp pin' }, ctx());
    const id = (pinResult as any).content[0].text.match(/id ([0-9a-f]{8})/)[1];

    const forgetResult = await memoryForget.executor({ id }, ctx());
    expect((forgetResult as any).content[0].text).toContain('removed 1 pinned');
  });
});

// ─── Tool definition metadata ────────────────────���──────────

describe('memory-write tool metadata', () => {
  it('all tools have searchHint', () => {
    for (const tool of memoryWriteTools) {
      expect(tool.definition.searchHint).toBeTruthy();
    }
  });

  it('memory_write and memory_pin are alwaysLoad', () => {
    expect(memoryWrite.definition.alwaysLoad).toBe(true);
    expect(memoryPin.definition.alwaysLoad).toBe(true);
    expect(memoryForget.definition.alwaysLoad).toBe(true);
  });
});
