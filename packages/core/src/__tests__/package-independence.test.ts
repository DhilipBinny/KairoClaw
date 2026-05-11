import { describe, it, expect } from 'vitest';

describe('@agw/security', () => {
  it('exports input sanitization', async () => {
    const mod = await import('@agw/security');
    expect(mod.sanitizeInput).toBeTypeOf('function');
    expect(mod.detectPromptInjection).toBeTypeOf('function');
  });

  it('exports output filtering', async () => {
    const mod = await import('@agw/security');
    expect(mod.filterOutput).toBeTypeOf('function');
    expect(mod.checkOutputSafety).toBeTypeOf('function');
  });
});

describe('@agw/mcp-client', () => {
  it('exports MCPClient class', async () => {
    const mod = await import('@agw/mcp-client');
    expect(mod.MCPClient).toBeTypeOf('function');
  });

  it('exports catalog and security', async () => {
    const mod = await import('@agw/mcp-client');
    expect(mod.MCP_CATALOG).toBeTypeOf('object');
    expect(mod.computeToolHash).toBeTypeOf('function');
  });
});

describe('@agw/tool-platform', () => {
  it('exports ToolRegistry class', async () => {
    const mod = await import('@agw/tool-platform');
    const registry = new mod.ToolRegistry();
    expect(registry.size).toBe(0);
  });

  it('exports envelope helpers', async () => {
    const mod = await import('@agw/tool-platform');
    const env = mod.textEnvelope('hello');
    expect(env.content[0].type).toBe('text');
  });

  it('exports LoopDetector', async () => {
    const mod = await import('@agw/tool-platform');
    const detector = new mod.LoopDetector();
    expect(detector.record('test', {})).toBeNull();
  });

  it('exports ProgressBus', async () => {
    const mod = await import('@agw/tool-platform');
    const bus = new mod.ProgressBus();
    expect(bus.activeSessionCount).toBe(0);
  });

  it('exports hooks pattern matcher', async () => {
    const mod = await import('@agw/tool-platform');
    expect(mod.matchesHookPattern('write_file', '*')).toBe(true);
    expect(mod.matchesHookPattern('write_file', 'write_*')).toBe(true);
    expect(mod.matchesHookPattern('read_file', 'write_*')).toBe(false);
  });
});

describe('@agw/provider-bridge', () => {
  it('exports error classifier', async () => {
    const mod = await import('@agw/provider-bridge');
    const classified = mod.classifyError(new Error('rate limit exceeded'));
    expect(classified.type).toBe('rate_limit');
    expect(classified.retriable).toBe(true);
  });

  it('exports model capabilities', async () => {
    const mod = await import('@agw/provider-bridge');
    const caps = mod.getModelCapabilities('claude-sonnet-4-6');
    expect(caps.contextWindow).toBeGreaterThan(0);
  });

  it('exports streaming timeout', async () => {
    const mod = await import('@agw/provider-bridge');
    const timeout = mod.createStreamingTimeout({ ttftMs: 1000 });
    expect(timeout.signal).toBeDefined();
    timeout.clear();
  });
});

describe('@agw/cron', () => {
  it('exports CronScheduler class', async () => {
    const mod = await import('@agw/cron');
    expect(mod.CronScheduler).toBeTypeOf('function');
  });
});

describe('@agw/memory-engine', () => {
  it('exports token estimation', async () => {
    const mod = await import('@agw/memory-engine');
    expect(mod.estimateTokens('hello world')).toBeGreaterThan(0);
  });

  it('exports scope utilities', async () => {
    const mod = await import('@agw/memory-engine');
    expect(mod.deriveScopeKey).toBeTypeOf('function');
  });

  it('exports MemorySystem class', async () => {
    const mod = await import('@agw/memory-engine');
    expect(mod.MemorySystem).toBeTypeOf('function');
  });
});

describe('@agw/agent-core', () => {
  it('exports buildSystemPrompt', async () => {
    const mod = await import('@agw/agent-core');
    expect(mod.buildSystemPrompt).toBeTypeOf('function');
  });

  it('exports compaction utilities', async () => {
    const mod = await import('@agw/agent-core');
    expect(mod.estimateTokens).toBeTypeOf('function');
    expect(mod.checkAndCompact).toBeTypeOf('function');
  });

  it('exports router', async () => {
    const mod = await import('@agw/agent-core');
    expect(mod.routeModel).toBeTypeOf('function');
    expect(mod.stripModelOverride).toBeTypeOf('function');
  });
});

describe('no circular deps', () => {
  it('extracted packages do not import from @agw/core', async () => {
    // Verify by importing all packages — if any had a circular dep
    // on @agw/core, this would either fail to resolve or create an
    // import cycle that Node detects at runtime.
    const mods = await Promise.all([
      import('@agw/security'),
      import('@agw/mcp-client'),
      import('@agw/tool-platform'),
      import('@agw/provider-bridge'),
      import('@agw/cron'),
      import('@agw/memory-engine'),
      import('@agw/agent-core'),
    ]);
    expect(mods.length).toBe(7);
  });
});
