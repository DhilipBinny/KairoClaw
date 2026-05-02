/**
 * Tests for the Phase 6.4 envelope output formats — confirms each
 * tool's text-shape contract (header, separators, fallback messages)
 * so future regressions show up immediately.
 *
 * Covers:
 * - envelope.ts helpers (textEnvelope, imageEnvelope, envelope)
 * - exec.formatExecResult
 * - memory_search executor — zero-match envelope and multi-match format
 *
 * Network-dependent tools (web_fetch) and external-binary tools
 * (read_pdf calls poppler) are exercised end-to-end on deploy/railway
 * — adding network/binary mocks here would test the mocks, not the
 * tools.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { textEnvelope, imageEnvelope, envelope } from '../../envelope.js';
import { formatExecResult } from '../exec.js';
import { memoryTools, setMemorySystem } from '../memory.js';

// ── envelope.ts helpers ──────────────────────────────────────

describe('textEnvelope', () => {
  it('wraps a string into a single text-block envelope', () => {
    expect(textEnvelope('hello')).toEqual({
      content: [{ type: 'text', text: 'hello' }],
    });
  });
  it('handles empty string', () => {
    expect(textEnvelope('')).toEqual({
      content: [{ type: 'text', text: '' }],
    });
  });
});

describe('imageEnvelope', () => {
  it('wraps base64 data into a single image block', () => {
    expect(imageEnvelope('image/png', 'AAAA')).toEqual({
      content: [{ type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'AAAA' } }],
    });
  });
  it('honours the kind override', () => {
    const env = imageEnvelope('image/jpeg', 'https://example.com/img.jpg', 'url');
    expect(env.content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'url', media_type: 'image/jpeg', data: 'https://example.com/img.jpg' },
    });
  });
});

describe('envelope (multi-block)', () => {
  it('wraps an arbitrary block list', () => {
    const blocks = [
      { type: 'text' as const, text: 'header' },
      { type: 'text' as const, text: 'body' },
    ];
    expect(envelope(blocks).content).toEqual(blocks);
  });
});

// ── exec.formatExecResult ────────────────────────────────────

describe('formatExecResult', () => {
  it('formats exit-code-only when stdout and stderr are empty (echo with no output)', () => {
    expect(formatExecResult('', '', 0)).toBe('exit code: 0');
  });

  it('formats stdout-only when stderr is empty (most common success case)', () => {
    expect(formatExecResult('hello\n', '', 0)).toBe('exit code: 0\n\nstdout:\nhello\n');
  });

  it('formats stderr-only when stdout is empty (warnings / failures with no output)', () => {
    expect(formatExecResult('', 'something failed\n', 1)).toBe('exit code: 1\n\nstderr:\nsomething failed\n');
  });

  it('formats both stdout and stderr when present', () => {
    expect(formatExecResult('one\n', 'two\n', 0)).toBe('exit code: 0\n\nstdout:\none\n\n\nstderr:\ntwo\n');
  });

  it('preserves the exit code in the header even on failure', () => {
    expect(formatExecResult('', '', 137)).toBe('exit code: 137');
    expect(formatExecResult('partial', 'oops', 2)).toContain('exit code: 2');
  });
});

// ── memory_search executor ───────────────────────────────────

const memorySearchTool = memoryTools.find(t => t.definition.name === 'memory_search')!;

interface MemoryChunk {
  id: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  score: number;
}

function makeMemoryStub(opts: { search: () => Promise<MemoryChunk[]>; totalChunks: number }) {
  return {
    search: async () => opts.search(),
    getStats: async () => ({ initialized: true, totalChunks: opts.totalChunks, indexedFiles: 1, files: [] }),
  };
}

const adminCtx = {
  user: { id: 'admin', role: 'admin', elevated: true },
  scopeKey: null,
  config: { agent: { workspace: '/tmp/kairo-test-ws' } },
} as unknown as Parameters<typeof memorySearchTool.executor>[1];

describe('memory_search envelope output', () => {
  afterEach(() => {
    // Reset to null to avoid leaking state across tests
    setMemorySystem(null as unknown as Parameters<typeof setMemorySystem>[0]);
  });

  it('returns a dedicated zero-match envelope when no chunks match', async () => {
    setMemorySystem(makeMemoryStub({
      search: async () => [],
      totalChunks: 42,
    }) as unknown as Parameters<typeof setMemorySystem>[0]);

    const result = await memorySearchTool.executor({ query: 'nothing matches' }, adminCtx);
    const env = result as { content: { type: string; text: string }[] };
    expect(env.content).toHaveLength(1);
    expect(env.content[0].type).toBe('text');
    expect(env.content[0].text).toContain('Query: nothing matches');
    expect(env.content[0].text).toContain('Total chunks indexed: 42');
    expect(env.content[0].text).toContain('No matches.');
  });

  it('formats multi-match results as [path:start-end] score=X.XX\\n<content>', async () => {
    setMemorySystem(makeMemoryStub({
      search: async () => [
        { id: 1, filePath: 'memory/PROFILE.md', lineStart: 10, lineEnd: 14, content: 'first match', score: 1.5 },
        { id: 2, filePath: 'memory/sessions/2026-04-30.md', lineStart: 1, lineEnd: 3, content: 'second', score: 0.8 },
      ],
      totalChunks: 100,
    }) as unknown as Parameters<typeof setMemorySystem>[0]);

    const result = await memorySearchTool.executor({ query: 'kairo' }, adminCtx);
    const text = (result as { content: { text: string }[] }).content[0].text;

    // Header
    expect(text).toContain('Query: kairo');
    expect(text).toContain('Total chunks indexed: 100');
    expect(text).toContain('Top 2 matches:');
    // Per-result format
    expect(text).toContain('[memory/PROFILE.md:10-14] score=1.50');
    expect(text).toContain('first match');
    expect(text).toContain('[memory/sessions/2026-04-30.md:1-3] score=0.80');
    expect(text).toContain('second');
  });

  it('uses singular "1 match" wording when exactly one result', async () => {
    setMemorySystem(makeMemoryStub({
      search: async () => [
        { id: 1, filePath: 'memory/PROFILE.md', lineStart: 1, lineEnd: 1, content: 'only one', score: 0.5 },
      ],
      totalChunks: 5,
    }) as unknown as Parameters<typeof setMemorySystem>[0]);

    const result = await memorySearchTool.executor({ query: 'unique' }, adminCtx);
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain('Top 1 match:');
    expect(text).not.toContain('Top 1 matches');
  });
});
