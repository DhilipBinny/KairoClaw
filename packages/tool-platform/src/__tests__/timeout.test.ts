import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../registry.js';

function makeRegistry(defaultTimeoutMs?: number): ToolRegistry {
  const reg = new ToolRegistry();
  if (defaultTimeoutMs !== undefined) reg.setDefaultTimeout(defaultTimeoutMs);
  return reg;
}

function registerTool(reg: ToolRegistry, name: string, executor: (args: any) => Promise<any>, timeoutMs?: number) {
  reg.register({
    definition: { name, description: `test tool ${name}`, parameters: { type: 'object', properties: {} } },
    executor,
    source: 'builtin',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

describe('tool execution timeout', () => {
  it('completes fast tools without timeout interference', async () => {
    const reg = makeRegistry(5000);
    registerTool(reg, 'fast_tool', async () => ({ text: 'done' }));
    const result = await reg.execute('fast_tool', {}, {} as any);
    expect(result).toEqual({ text: 'done' });
  });

  it('times out a slow tool with default timeout', async () => {
    const reg = makeRegistry(100);
    registerTool(reg, 'slow_tool', async () => {
      await new Promise(r => setTimeout(r, 5000));
      return { text: 'should not reach' };
    });
    const result = await reg.execute('slow_tool', {}, {} as any);
    expect(result).toEqual({ error: expect.stringContaining('timed out after') });
  });

  it('per-tool timeout overrides default', async () => {
    const reg = makeRegistry(5000);
    registerTool(reg, 'custom_timeout', async () => {
      await new Promise(r => setTimeout(r, 500));
      return { text: 'should not reach' };
    }, 100);
    const result = await reg.execute('custom_timeout', {}, {} as any);
    expect(result).toEqual({ error: expect.stringContaining('timed out after') });
  });

  it('per-tool timeout of 0 disables safety net', async () => {
    const reg = makeRegistry(100);
    registerTool(reg, 'no_timeout', async () => {
      await new Promise(r => setTimeout(r, 200));
      return { text: 'completed' };
    }, 0);
    const result = await reg.execute('no_timeout', {}, {} as any);
    expect(result).toEqual({ text: 'completed' });
  });

  it('timeout error message includes tool name', async () => {
    const reg = makeRegistry(50);
    registerTool(reg, 'named_tool', async () => {
      await new Promise(r => setTimeout(r, 5000));
      return { text: 'nope' };
    });
    const result = await reg.execute('named_tool', {}, {} as any);
    expect((result as any).error).toContain('named_tool');
  });
});
