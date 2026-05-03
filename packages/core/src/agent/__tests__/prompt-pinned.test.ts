import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildSystemPrompt } from '../prompt.js';
import type { GatewayConfig } from '@agw/types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-pin-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(workspace: string): GatewayConfig {
  return {
    agent: { name: 'TestBot', workspace },
    model: { primary: 'anthropic/claude-sonnet-4-6', fallback: '' },
  } as unknown as GatewayConfig;
}

describe('buildSystemPrompt — PINNED.md injection', () => {
  it('injects pinned notes into dynamic section when PINNED.md exists', () => {
    const memoryDir = path.join(tmpDir, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, 'PINNED.md'),
      '# Pinned Notes\n\n- (2025-01-01T00:00:00.000Z id:aabbccdd) Always use TypeScript\n',
    );
    const result = buildSystemPrompt(makeConfig(tmpDir), []);
    expect(result.dynamic).toContain('Pinned Notes (always load)');
    expect(result.dynamic).toContain('Always use TypeScript');
  });

  it('injects scoped PINNED.md when scopeKey is provided', () => {
    const memoryDir = path.join(tmpDir, 'scopes', 'user1', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, 'PINNED.md'),
      '# Pinned Notes\n\n- (2025-01-01T00:00:00.000Z id:11223344) User prefers dark mode\n',
    );
    const result = buildSystemPrompt(makeConfig(tmpDir), [], 'user1');
    expect(result.dynamic).toContain('User prefers dark mode');
  });

  it('does not inject when PINNED.md is missing', () => {
    const result = buildSystemPrompt(makeConfig(tmpDir), []);
    expect(result.dynamic).not.toContain('Pinned Notes');
  });

  it('does not inject when PINNED.md is empty', () => {
    const memoryDir = path.join(tmpDir, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'PINNED.md'), '   \n  ');
    const result = buildSystemPrompt(makeConfig(tmpDir), []);
    expect(result.dynamic).not.toContain('Pinned Notes');
  });
});
