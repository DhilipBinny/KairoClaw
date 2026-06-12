import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pluginTools } from '../plugins.js';

/**
 * #180 — mutating manage_plugins actions (add/update/remove) are gated to
 * admin (defense in depth alongside the per-call exec policy in the CLI plugin
 * executor). `list` stays open. These tests lock in the gate so a revert of the
 * `if (action !== 'list')` block is caught.
 */

const exec = pluginTools[0].executor;
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-plugins-gate-'));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const ctx = (role: string | undefined) => ({
  config: { _stateDir: stateDir },
  user: role === undefined ? undefined : { role },
}) as any;

describe('manage_plugins admin gate (#180)', () => {
  for (const action of ['add', 'update', 'remove'] as const) {
    it(`rejects a non-admin (role:user) ${action}`, async () => {
      const res = await exec({ action, type: 'cli', name: 'x', plugin: { name: 'x', command: 'gh' } }, ctx('user'));
      expect((res as any).error).toMatch(/Forbidden/i);
    });

    it(`rejects a viewer ${action}`, async () => {
      const res = await exec({ action, type: 'cli', name: 'x' }, ctx('viewer'));
      expect((res as any).error).toMatch(/Forbidden/i);
    });

    it(`rejects an unauthenticated/undefined-user ${action}`, async () => {
      const res = await exec({ action, type: 'cli', name: 'x' }, ctx(undefined));
      expect((res as any).error).toMatch(/Forbidden/i);
    });
  }

  it('lets an admin PAST the gate (fails later for a different reason, not Forbidden)', async () => {
    // Admin add with no plugin object → passes the gate, then hits the normal
    // validation error. Proves the gate let the admin through without spawning.
    const res = await exec({ action: 'add', type: 'cli' }, ctx('admin'));
    expect((res as any).error).toBeDefined();
    expect((res as any).error).not.toMatch(/Forbidden/i);
    expect((res as any).error).toMatch(/plugin object is required/i);
  });

  it('allows a non-admin to LIST plugins', async () => {
    const res = await exec({ action: 'list' }, ctx('user'));
    expect((res as any).error).toBeUndefined();
    expect(res).toHaveProperty('cli');
  });
});
