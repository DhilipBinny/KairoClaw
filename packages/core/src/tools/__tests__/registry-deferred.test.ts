import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolRegistration } from '@agw/tool-platform';

function makeTool(name: string, alwaysLoad = false): ToolRegistration {
  return {
    definition: {
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: {} },
      alwaysLoad,
    },
    executor: async () => ({ ok: true }),
    source: 'builtin',
    category: 'read',
  };
}

describe('ToolRegistry — deferred loading (Phase 8)', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeTool('read_file', true));
    registry.register(makeTool('edit_file', true));
    registry.register(makeTool('tool_search', true));
    registry.register(makeTool('send_email', false));
    registry.register(makeTool('read_pdf', false));
    registry.register(makeTool('browse', false));
  });

  it('getAlwaysLoadDefinitions returns only alwaysLoad=true tools', async () => {
    const defs = await registry.getAlwaysLoadDefinitions();
    const names = defs.map(d => d.name);
    expect(names).toContain('read_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('tool_search');
    expect(names).not.toContain('send_email');
    expect(names).not.toContain('read_pdf');
  });

  it('getDefinitionsForSession returns alwaysLoad + session-loaded tools', async () => {
    registry.loadForSession('sess-1', ['send_email']);
    const defs = await registry.getDefinitionsForSession('sess-1');
    const names = defs.map(d => d.name);
    expect(names).toContain('read_file');
    expect(names).toContain('send_email');
    expect(names).not.toContain('read_pdf');
  });

  it('loadForSession ignores unknown tool names', () => {
    const added = registry.loadForSession('sess-1', ['nonexistent_tool']);
    expect(added).toBe(0);
    expect(registry.getSessionLoaded('sess-1')).toEqual([]);
  });

  it('loadForSession ignores duplicates', () => {
    const first = registry.loadForSession('sess-1', ['send_email']);
    const second = registry.loadForSession('sess-1', ['send_email']);
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it('clearSessionLoaded resets the loaded set', async () => {
    registry.loadForSession('sess-1', ['send_email', 'read_pdf']);
    expect(registry.getSessionLoaded('sess-1')).toHaveLength(2);
    registry.clearSessionLoaded('sess-1');
    expect(registry.getSessionLoaded('sess-1')).toHaveLength(0);

    const defs = await registry.getDefinitionsForSession('sess-1');
    const names = defs.map(d => d.name);
    expect(names).not.toContain('send_email');
  });

  it('session loading is isolated between sessions', () => {
    registry.loadForSession('sess-1', ['send_email']);
    registry.loadForSession('sess-2', ['read_pdf']);
    expect(registry.getSessionLoaded('sess-1')).toEqual(['send_email']);
    expect(registry.getSessionLoaded('sess-2')).toEqual(['read_pdf']);
  });
});
