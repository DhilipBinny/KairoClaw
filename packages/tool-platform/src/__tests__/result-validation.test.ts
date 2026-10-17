import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../registry.js';

function makeRegistry(): ToolRegistry {
  return new ToolRegistry();
}

function registerTool(
  reg: ToolRegistry,
  name: string,
  executor: (args: any) => Promise<any>,
  resultSchema?: { type: 'object'; required?: string[] },
) {
  reg.register({
    definition: { name, description: `test ${name}`, parameters: { type: 'object', properties: {} } },
    executor,
    source: 'builtin',
    resultSchema,
  });
}

describe('tool result schema validation', () => {
  it('passes when result has all required fields', async () => {
    const reg = makeRegistry();
    registerTool(reg, 'good_tool', async () => JSON.stringify({ text: 'hello', status: 'ok' }), {
      type: 'object',
      required: ['text', 'status'],
    });
    const result = await reg.execute('good_tool', {}, {} as any);
    expect(result).toBe('{"text":"hello","status":"ok"}');
  });

  it('returns error when required field is missing', async () => {
    const reg = makeRegistry();
    registerTool(reg, 'missing_field', async () => JSON.stringify({ text: 'hello' }), {
      type: 'object',
      required: ['text', 'status'],
    });
    const result = await reg.execute('missing_field', {}, {} as any);
    expect(result).toEqual({ error: expect.stringContaining('Missing required fields: status') });
  });

  it('returns error when result is not valid JSON', async () => {
    const reg = makeRegistry();
    registerTool(reg, 'bad_json', async () => 'not json at all', {
      type: 'object',
      required: ['text'],
    });
    const result = await reg.execute('bad_json', {}, {} as any);
    expect(result).toEqual({ error: expect.stringContaining('not valid JSON') });
  });

  it('returns error when result is not an object', async () => {
    const reg = makeRegistry();
    registerTool(reg, 'array_result', async () => JSON.stringify([1, 2, 3]), {
      type: 'object',
      required: ['items'],
    });
    const result = await reg.execute('array_result', {}, {} as any);
    expect(result).toEqual({ error: expect.stringContaining('not a JSON object') });
  });

  it('skips validation when no resultSchema is set', async () => {
    const reg = makeRegistry();
    registerTool(reg, 'no_schema', async () => 'plain text response');
    const result = await reg.execute('no_schema', {}, {} as any);
    expect(result).toBe('plain text response');
  });

  it('skips validation when result is already an error', async () => {
    const reg = makeRegistry();
    registerTool(reg, 'error_tool', async () => ({ error: 'tool failed' }), {
      type: 'object',
      required: ['text'],
    });
    const result = await reg.execute('error_tool', {}, {} as any);
    expect(result).toEqual({ error: 'tool failed' });
  });

  it('passes with no required fields (just type check)', async () => {
    const reg = makeRegistry();
    registerTool(reg, 'any_object', async () => JSON.stringify({ anything: true }), {
      type: 'object',
    });
    const result = await reg.execute('any_object', {}, {} as any);
    expect(result).toBe('{"anything":true}');
  });

  it('validates object results (not just strings)', async () => {
    const reg = makeRegistry();
    registerTool(reg, 'obj_result', async () => ({ text: 'hello' }), {
      type: 'object',
      required: ['text', 'missing'],
    });
    const result = await reg.execute('obj_result', {}, {} as any);
    expect(result).toEqual({ error: expect.stringContaining('Missing required fields: missing') });
  });

  it('unwraps ToolResultEnvelope and validates the text payload', async () => {
    const reg = makeRegistry();
    registerTool(reg, 'envelope_tool', async () => ({
      content: [{ type: 'text', text: '{"url":"https://example.com","title":"Test"}' }],
    }), {
      type: 'object',
      required: ['url', 'title'],
    });
    const result = await reg.execute('envelope_tool', {}, {} as any);
    expect(result).toEqual({ content: [{ type: 'text', text: '{"url":"https://example.com","title":"Test"}' }] });
  });

  it('returns error when ToolResultEnvelope payload is missing required fields', async () => {
    const reg = makeRegistry();
    registerTool(reg, 'envelope_missing', async () => ({
      content: [{ type: 'text', text: '{"url":"https://example.com"}' }],
    }), {
      type: 'object',
      required: ['url', 'title'],
    });
    const result = await reg.execute('envelope_missing', {}, {} as any);
    expect(result).toEqual({ error: expect.stringContaining('Missing required fields: title') });
  });
});
