import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '@agw/agent-core';
import type { GatewayConfig } from '@agw/types';

const minimalConfig: GatewayConfig = {
  agent: { name: 'TestBot', workspace: '/tmp/test-ws' },
  model: { primary: 'anthropic/claude-sonnet-4-6', fallback: '' },
} as unknown as GatewayConfig;

describe('buildSystemPrompt — vision declaration', () => {
  it('includes vision section when supportsVision is true', () => {
    const result = buildSystemPrompt(minimalConfig, [], null, null, null, false, { supportsVision: true });
    expect(result.cached).toContain('## Vision');
    expect(result.cached).toContain('You **can see images**');
    expect(result.cached).toContain('Do not claim you cannot see images');
  });

  it('omits vision section when supportsVision is false', () => {
    const result = buildSystemPrompt(minimalConfig, [], null, null, null, false, { supportsVision: false });
    expect(result.cached).not.toContain('## Vision');
  });

  it('omits vision section when opts is undefined', () => {
    const result = buildSystemPrompt(minimalConfig, []);
    expect(result.cached).not.toContain('## Vision');
  });

  it('vision section appears before tooling section', () => {
    const result = buildSystemPrompt(
      minimalConfig,
      [{ name: 'test_tool', description: 'A test', parameters: { type: 'object', properties: {}, required: [] } }],
      null, null, null, false,
      { supportsVision: true },
    );
    const visionIdx = result.cached.indexOf('## Vision');
    const toolsIdx = result.cached.indexOf('## Tools');
    expect(visionIdx).toBeGreaterThan(-1);
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(visionIdx).toBeLessThan(toolsIdx);
  });
});
