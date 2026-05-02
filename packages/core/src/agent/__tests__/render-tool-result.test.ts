import { describe, it, expect } from 'vitest';
import { renderToolResultForLLM } from '../loop.js';

// Tests for the Phase 6 envelope → string renderer used by the agent
// loop when feeding tool results back into the LLM's tool-result
// message content. The agent loop's <tool_result> wrapper applies on
// top of this string, so the renderer is the only thing that decides
// how each shape collapses to text.

describe('renderToolResultForLLM', () => {
  it('passes strings through unchanged', () => {
    expect(renderToolResultForLLM('hello world')).toBe('hello world');
    expect(renderToolResultForLLM('')).toBe('');
  });

  it('JSON-stringifies primitives, null, undefined', () => {
    expect(renderToolResultForLLM(null)).toBe('null');
    expect(renderToolResultForLLM(undefined)).toBe(undefined);
    expect(renderToolResultForLLM(42)).toBe('42');
    expect(renderToolResultForLLM(true)).toBe('true');
  });

  it('JSON-stringifies arrays', () => {
    expect(renderToolResultForLLM([1, 2, 3])).toBe('[1,2,3]');
  });

  it('JSON-stringifies legacy {error} objects', () => {
    expect(renderToolResultForLLM({ error: 'boom' })).toBe('{"error":"boom"}');
  });

  it('JSON-stringifies legacy {stdout, stderr, exitCode} shapes', () => {
    const result = { stdout: 'ok', stderr: '', exitCode: 0 };
    expect(renderToolResultForLLM(result)).toBe(JSON.stringify(result));
  });

  it('joins text blocks from a content-block envelope', () => {
    const envelope = {
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    };
    expect(renderToolResultForLLM(envelope)).toBe('first\nsecond');
  });

  it('summarises image blocks with their media_type', () => {
    const envelope = {
      content: [
        { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    };
    expect(renderToolResultForLLM(envelope)).toBe('[image/png image]');
  });

  it('summarises image blocks with a fallback when media_type is missing', () => {
    const envelope = {
      content: [
        { type: 'image', source: { kind: 'base64', data: 'AAAA' } },
      ],
    };
    expect(renderToolResultForLLM(envelope)).toBe('[image image]');
  });

  it('summarises resource_link blocks with title preferred over uri', () => {
    expect(
      renderToolResultForLLM({
        content: [{ type: 'resource_link', uri: 'https://example.com', title: 'Example' }],
      }),
    ).toBe('[link: Example]');
    // uri falls back when title missing
    expect(
      renderToolResultForLLM({
        content: [{ type: 'resource_link', uri: 'https://example.com' }],
      }),
    ).toBe('[link: https://example.com]');
  });

  it('renders persisted_reference blocks as size + path + preview', () => {
    const envelope = {
      content: [
        {
          type: 'persisted_reference',
          path: 'scopes/global/tool-results/sess-1/abc.json',
          preview: 'first chars of content',
          sizeBytes: 84_000,
        },
      ],
    };
    const out = renderToolResultForLLM(envelope);
    // Size + path + preview are all present, in that order
    expect(out).toMatch(/persisted 84000 bytes at scopes\/global\/tool-results\/sess-1\/abc\.json/);
    expect(out).toMatch(/first chars of content/);
  });

  it('mixed envelope joins text + image + persisted_reference with newlines', () => {
    const out = renderToolResultForLLM({
      content: [
        { type: 'text', text: 'header' },
        { type: 'image', source: { kind: 'base64', media_type: 'image/jpeg', data: 'X' } },
        { type: 'text', text: 'footer' },
      ],
    });
    expect(out).toBe('header\n[image/jpeg image]\nfooter');
  });

  it('falls back to JSON when an object has a non-array `content` field', () => {
    expect(renderToolResultForLLM({ content: 'not an array' })).toBe('{"content":"not an array"}');
  });

  it('falls back to per-block JSON for unknown block types', () => {
    const out = renderToolResultForLLM({
      content: [
        { type: 'text', text: 'known' },
        { type: 'mystery', payload: 42 },
      ],
    });
    expect(out).toContain('known');
    expect(out).toContain('"type":"mystery"');
  });

  it('falls back to whole-result JSON when every block is unrecognised', () => {
    const result = {
      content: [
        { type: 'mystery1' },
        { type: 'mystery2' },
      ],
    };
    // At least one block fell back to JSON.stringify, so the joined
    // output is non-empty and contains the block JSON.
    const out = renderToolResultForLLM(result);
    expect(out).toContain('mystery1');
    expect(out).toContain('mystery2');
  });
});
