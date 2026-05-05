import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeMessagesForLog, appendDebugLog } from '../loop.js';

const TMP_DIR = `/tmp/kairo-test-debug-recording-${Date.now()}`;

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ─── sanitizeMessagesForLog ─────────────────────────────────────────

describe('sanitizeMessagesForLog', () => {
  it('strips base64 image data and replaces with [omitted]', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this image' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg...' },
          },
        ],
      },
    ] as any;

    const result = sanitizeMessagesForLog(messages);
    const sanitized = result[0] as any;
    expect(sanitized.content[0].text).toBe('Look at this image');
    expect(sanitized.content[1].source.data).toBe('[omitted]');
    expect(sanitized.content[1].source.media_type).toBe('image/png');
  });

  it('preserves non-image messages unchanged', () => {
    const messages = [
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: 'Hi there' },
    ] as any;

    const result = sanitizeMessagesForLog(messages);
    expect(result[0]).toEqual({ role: 'user', content: 'Hello world' });
    expect(result[1]).toEqual({ role: 'assistant', content: 'Hi there' });
  });
});

// ─── appendDebugLog ─────────────────────────────────────────────────

describe('appendDebugLog', () => {
  it('creates the debug directory and writes JSONL', () => {
    const entry = { model: 'test', tokens: 100 };
    appendDebugLog(TMP_DIR, entry);

    const dir = path.join(TMP_DIR, 'debug', 'llm-requests');
    expect(fs.existsSync(dir)).toBe(true);

    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    const parsed = JSON.parse(content.trim());
    expect(parsed).toEqual(entry);
  });

  it('appends to existing file (multiple entries)', () => {
    const workspace = path.join(TMP_DIR, 'multi');
    const entry1 = { round: 1 };
    const entry2 = { round: 2 };

    appendDebugLog(workspace, entry1);
    appendDebugLog(workspace, entry2);

    const dir = path.join(workspace, 'debug', 'llm-requests');
    const files = fs.readdirSync(dir);
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual(entry1);
    expect(JSON.parse(lines[1])).toEqual(entry2);
  });
});
