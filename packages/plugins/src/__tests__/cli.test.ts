import { describe, it, expect } from 'vitest';
import { noopLogger } from '@agw/types';
import type { ToolRegistration } from '@agw/tool-platform';
import { registerCliPlugins } from '../cli.js';

/**
 * #180 — a CLI plugin must NOT be a sandbox-escape hatch. A plugin wrapping
 * bash/sh/python executes via execFile bypassing the `exec` tool, so the CLI
 * executor itself must enforce the same command policy. These tests register a
 * plugin that wraps `bash` and confirm a non-admin caller is blocked on the
 * exec-policy (the block path returns BEFORE any process is spawned).
 */

function makeRegistry() {
  const tools = new Map<string, ToolRegistration>();
  return {
    registry: {
      register(t: ToolRegistration) { tools.set(t.definition.name, t); },
      unregister(name: string) { tools.delete(name); },
    },
    get(name: string) { return tools.get(name); },
  };
}

function bashPluginConfig() {
  return {
    plugins: {
      cli: [{
        name: 'shell',
        command: 'bash',
        description: 'bash',
        enabled: true,
        timeout: 30,
        allowedSubcommands: [] as string[],
        blockedSubcommands: [] as string[],
        requireConfirmation: [] as string[],
        env: [] as string[],
      }],
    },
  } as any;
}

const nonAdminCtx = (over: Record<string, unknown> = {}) => ({
  user: { role: 'user' },
  scopeKey: 'user-abc',
  workspace: '/srv/app/agw-data/workspace',
  ...over,
});

describe('CLI plugin exec-policy enforcement (#180)', () => {
  it('registers a cli_<name> tool', () => {
    const { registry, get } = makeRegistry();
    const names = registerCliPlugins(bashPluginConfig(), registry, noopLogger);
    expect(names).toContain('cli_shell');
    expect(get('cli_shell')).toBeDefined();
  });

  it('blocks a non-admin from reading the master key through the plugin', async () => {
    const { registry, get } = makeRegistry();
    registerCliPlugins(bashPluginConfig(), registry, noopLogger);
    const tool = get('cli_shell')!;
    const res = await tool.executor({ args: '-c "cat master.key"' }, nonAdminCtx() as any);
    expect((res as any).error).toMatch(/Blocked/i);
    expect((res as any).stdout).toBeUndefined(); // never executed
  });

  it('blocks a non-admin from reading another user\'s scope through the plugin', async () => {
    const { registry, get } = makeRegistry();
    registerCliPlugins(bashPluginConfig(), registry, noopLogger);
    const tool = get('cli_shell')!;
    const res = await tool.executor({ args: '-c "cat scopes/other-user/secret.md"' }, nonAdminCtx() as any);
    expect((res as any).error).toMatch(/denied|Blocked/i);
  });

  it('still blocks catastrophic commands even for an admin caller', async () => {
    const { registry, get } = makeRegistry();
    registerCliPlugins(bashPluginConfig(), registry, noopLogger);
    const tool = get('cli_shell')!;
    const res = await tool.executor(
      { args: '-c "rm -rf /"' },
      nonAdminCtx({ user: { role: 'admin' } }) as any,
    );
    expect((res as any).error).toMatch(/Blocked/i);
  });
});
