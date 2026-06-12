/**
 * Integration tests — require a real Docker daemon + kairoclaw-sandbox:full image.
 * Skip if Docker is not available.
 *
 * Run: pnpm vitest run packages/sandbox/src/__tests__/integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContainerManager } from '../container-manager.js';
import { isDockerAvailable, imageExists, listSandboxContainers, removeContainer } from '../docker-client.js';
import { getDefaults } from '../config.js';
import type { SandboxToolConfig } from '@agw/types';

const SOCKET = '/var/run/docker.sock';
const IMAGE = 'kairoclaw-sandbox:full';

let dockerReady = false;
let tmpDir: string;

function makeConfig(overrides?: Partial<SandboxToolConfig>): SandboxToolConfig {
  return { ...getDefaults(), enabled: true, image: IMAGE, ...overrides };
}

beforeAll(async () => {
  const avail = await isDockerAvailable(SOCKET);
  if (!avail) {
    console.warn('Docker not available — skipping integration tests');
    return;
  }
  const img = await imageExists(SOCKET, IMAGE);
  if (!img) {
    console.warn(`Image ${IMAGE} not found — skipping integration tests`);
    return;
  }
  dockerReady = true;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-integ-'));
  fs.mkdirSync(path.join(tmpDir, 'shared', 'documents'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'IDENTITY.md'), '# Test Agent');
  fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '# Personality');
  fs.writeFileSync(path.join(tmpDir, 'RULES.md'), '# Rules');
});

afterAll(async () => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  // Clean up any leftover containers
  try {
    const leftovers = await listSandboxContainers(SOCKET);
    for (const c of leftovers) {
      await removeContainer(SOCKET, c.id);
    }
  } catch { /* ignore */ }
});

// Helper to skip if Docker not ready
function dockerIt(name: string, fn: () => Promise<void>, timeout?: number) {
  it(name, async () => {
    if (!dockerReady) return;
    await fn();
  }, timeout ?? 30000);
}

// ═══════════════════════════════════════════════
// Basic exec
// ═══════════════════════════════════════════════
describe('integration: basic exec', () => {
  let cm: ContainerManager;

  afterEach(async () => {
    if (cm) await cm.destroyAll();
  });

  dockerIt('runs a simple echo command', async () => {
    cm = new ContainerManager(makeConfig());
    const result = await cm.exec({
      userId: 'test-user', sessionId: 'sess-1', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'echo hello world',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
    expect(result.stderr).toBe('');
  });

  dockerIt('captures stderr', async () => {
    cm = new ContainerManager(makeConfig());
    const result = await cm.exec({
      userId: 'test-user', sessionId: 'sess-2', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'echo error >&2',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe('error');
  });

  dockerIt('returns non-zero exit code', async () => {
    cm = new ContainerManager(makeConfig());
    const result = await cm.exec({
      userId: 'test-user', sessionId: 'sess-3', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'exit 42',
    });
    expect(result.exitCode).toBe(42);
  });

  dockerIt('times out long-running commands', async () => {
    cm = new ContainerManager(makeConfig());
    const result = await cm.exec({
      userId: 'test-user', sessionId: 'sess-4', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'sleep 60',
      timeout: 3,
    });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
  });

  dockerIt('has node and python available', async () => {
    cm = new ContainerManager(makeConfig());
    const node = await cm.exec({
      userId: 'test-user', sessionId: 'sess-5', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'node --version',
    });
    expect(node.exitCode).toBe(0);
    expect(node.stdout.trim()).toMatch(/^v22\./);

    const python = await cm.exec({
      userId: 'test-user', sessionId: 'sess-5', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'python3 --version',
    });
    expect(python.exitCode).toBe(0);
    expect(python.stdout.trim()).toMatch(/^Python 3\.1[0-9]/);
  });
});

// ═══════════════════════════════════════════════
// Container lifecycle
// ═══════════════════════════════════════════════
describe('integration: container lifecycle', () => {
  let cm: ContainerManager;

  afterEach(async () => {
    if (cm) await cm.destroyAll();
  });

  dockerIt('reuses container across calls (persistent state)', async () => {
    cm = new ContainerManager(makeConfig());
    // Create a file in first call
    await cm.exec({
      userId: 'life-user', sessionId: 'life-sess', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'echo "persisted" > /tmp/testfile.txt',
    });
    // Read it in second call — should still exist
    const result = await cm.exec({
      userId: 'life-user', sessionId: 'life-sess', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'cat /tmp/testfile.txt',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('persisted');
  });

  dockerIt('destroyForSession removes the container', async () => {
    cm = new ContainerManager(makeConfig());
    await cm.exec({
      userId: 'life-user', sessionId: 'destroy-sess', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'echo hi',
    });
    expect(cm.hasContainer('life-user', 'destroy-sess')).toBe(true);
    await cm.destroyForSession('life-user', 'destroy-sess');
    expect(cm.hasContainer('life-user', 'destroy-sess')).toBe(false);

    // Verify container is actually gone from Docker
    const containers = await listSandboxContainers(SOCKET);
    const found = containers.find(c => c.labels['kairoclaw.sandbox.session'] === 'destroy-sess');
    expect(found).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════
// Mount modes
// ═══════════════════════════════════════════════
describe('integration: mount modes', () => {
  let cm: ContainerManager;

  afterEach(async () => {
    if (cm) await cm.destroyAll();
  });

  dockerIt('read-write mode: files persist to host', async () => {
    cm = new ContainerManager(makeConfig({
      defaults: { ...getDefaults().defaults, workspace: 'read-write' },
    }));
    const scopeKey = 'mount-rw-user';
    const scopeDir = path.join(tmpDir, 'scopes', scopeKey);
    fs.mkdirSync(scopeDir, { recursive: true });

    await cm.exec({
      userId: 'mount-user', sessionId: 'mount-sess-rw', role: 'user',
      workspacePath: tmpDir, scopeKey, isAdmin: false,
      command: 'echo "from sandbox" > /workspace/test-rw.txt',
    });

    // Check file exists on host
    const hostFile = path.join(scopeDir, 'test-rw.txt');
    expect(fs.existsSync(hostFile)).toBe(true);
    expect(fs.readFileSync(hostFile, 'utf8').trim()).toBe('from sandbox');

    // Cleanup
    fs.unlinkSync(hostFile);
  });

  dockerIt('read-only mode: writes fail', async () => {
    cm = new ContainerManager(makeConfig({
      defaults: { ...getDefaults().defaults, workspace: 'read-only' },
    }));
    const scopeKey = 'mount-ro-user';
    const scopeDir = path.join(tmpDir, 'scopes', scopeKey);
    fs.mkdirSync(scopeDir, { recursive: true });

    const result = await cm.exec({
      userId: 'mount-user-ro', sessionId: 'mount-sess-ro', role: 'user',
      workspacePath: tmpDir, scopeKey, isAdmin: false,
      command: 'touch /workspace/should-fail.txt 2>&1; echo "exit:$?"',
    });
    expect(result.stdout).toContain('exit:1');
    expect(fs.existsSync(path.join(scopeDir, 'should-fail.txt'))).toBe(false);
  });

  dockerIt('none mode: /workspace is empty', async () => {
    cm = new ContainerManager(makeConfig({
      defaults: { ...getDefaults().defaults, workspace: 'none' },
    }));

    const result = await cm.exec({
      userId: 'mount-user-none', sessionId: 'mount-sess-none', role: 'user',
      workspacePath: tmpDir, scopeKey: 'mount-none-user', isAdmin: false,
      command: 'ls -la /workspace/ | wc -l',
    });
    expect(result.exitCode).toBe(0);
    // Should be basically empty (just . and ..)
    const lineCount = parseInt(result.stdout.trim());
    expect(lineCount).toBeLessThanOrEqual(3);
  });

  dockerIt('admin gets full workspace mounted', async () => {
    cm = new ContainerManager(makeConfig());
    // Write a marker file to workspace root
    fs.writeFileSync(path.join(tmpDir, 'admin-marker.txt'), 'admin-test');

    const result = await cm.exec({
      userId: 'admin-user', sessionId: 'admin-mount-sess', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'cat /workspace/admin-marker.txt',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('admin-test');

    fs.unlinkSync(path.join(tmpDir, 'admin-marker.txt'));
  });

  dockerIt('non-admin sees shared/ as read-only', async () => {
    cm = new ContainerManager(makeConfig());
    const scopeKey = 'shared-test-user';
    fs.mkdirSync(path.join(tmpDir, 'scopes', scopeKey), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'shared', 'documents', 'readme.txt'), 'shared content');

    const result = await cm.exec({
      userId: 'shared-user', sessionId: 'shared-sess', role: 'user',
      workspacePath: tmpDir, scopeKey, isAdmin: false,
      command: 'cat /shared/documents/readme.txt',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('shared content');

    // Should not be able to write to shared
    const writeResult = await cm.exec({
      userId: 'shared-user', sessionId: 'shared-sess', role: 'user',
      workspacePath: tmpDir, scopeKey, isAdmin: false,
      command: 'touch /shared/hack.txt 2>&1; echo "exit:$?"',
    });
    expect(writeResult.stdout).toContain('exit:1');
  });

  dockerIt('non-admin sees persona files as read-only', async () => {
    cm = new ContainerManager(makeConfig());
    const scopeKey = 'persona-test-user';
    fs.mkdirSync(path.join(tmpDir, 'scopes', scopeKey), { recursive: true });

    const result = await cm.exec({
      userId: 'persona-user', sessionId: 'persona-sess', role: 'user',
      workspacePath: tmpDir, scopeKey, isAdmin: false,
      command: 'cat /persona/IDENTITY.md',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('# Test Agent');

    // Should not be able to write persona files
    const writeResult = await cm.exec({
      userId: 'persona-user', sessionId: 'persona-sess', role: 'user',
      workspacePath: tmpDir, scopeKey, isAdmin: false,
      command: 'echo "hacked" > /persona/IDENTITY.md 2>&1; echo "exit:$?"',
    });
    // Exit code varies by shell (1 = permission denied, 2 = cannot create)
    expect(writeResult.stdout).toMatch(/exit:[12]/);
  });
});

// ═══════════════════════════════════════════════
// Network tiers
// ═══════════════════════════════════════════════
describe('integration: network tiers', () => {
  let cm: ContainerManager;

  afterEach(async () => {
    if (cm) await cm.destroyAll();
  });

  dockerIt('open tier: can reach the internet', async () => {
    cm = new ContainerManager(makeConfig({
      defaults: { ...getDefaults().defaults, network: 'open' },
    }));
    const result = await cm.exec({
      userId: 'net-user', sessionId: 'net-open', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'curl -sf --max-time 10 https://example.com >/dev/null && echo "OK" || echo "FAIL"',
    });
    expect(result.stdout.trim()).toBe('OK');
  }, 20000);

  dockerIt('locked tier: no network at all', async () => {
    cm = new ContainerManager(makeConfig({
      defaults: { ...getDefaults().defaults, network: 'locked' },
    }));
    const result = await cm.exec({
      userId: 'net-user', sessionId: 'net-locked', role: 'user',
      workspacePath: tmpDir, scopeKey: 'net-locked-user', isAdmin: false,
      command: 'curl -sf --max-time 3 https://example.com 2>&1 || echo "BLOCKED"',
      timeout: 10,
    });
    expect(result.stdout).toContain('BLOCKED');
  }, 20000);
});

// ═══════════════════════════════════════════════
// Security hardening
// ═══════════════════════════════════════════════
describe('integration: security hardening', () => {
  let cm: ContainerManager;

  afterEach(async () => {
    if (cm) await cm.destroyAll();
  });

  dockerIt('runs as non-root (uid 1000)', async () => {
    cm = new ContainerManager(makeConfig());
    const result = await cm.exec({
      userId: 'sec-user', sessionId: 'sec-sess', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'id -u',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1000');
  });

  dockerIt('cannot access host filesystem outside mounts', async () => {
    cm = new ContainerManager(makeConfig());
    const result = await cm.exec({
      userId: 'sec-user', sessionId: 'sec-host', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'cat /etc/shadow 2>&1; echo "exit:$?"',
    });
    // Should fail — either permission denied or file doesn't exist meaningfully
    expect(result.stdout).toContain('exit:1');
  });

  dockerIt('no-new-privileges prevents setuid escalation', async () => {
    cm = new ContainerManager(makeConfig());
    const result = await cm.exec({
      userId: 'sec-user', sessionId: 'sec-priv', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'cat /proc/self/status | grep NoNewPrivs',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1');
  });

  dockerIt('PID limit is enforced', async () => {
    cm = new ContainerManager(makeConfig({
      defaults: { ...getDefaults().defaults, pidsLimit: 32 },
    }));
    // Try to spawn more processes than the limit
    const result = await cm.exec({
      userId: 'sec-user', sessionId: 'sec-pids', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'for i in $(seq 1 50); do sleep 100 & done 2>&1; echo "spawned:$(jobs -p | wc -l)"',
      timeout: 10,
    });
    // Should not have all 50 — PID limit should kick in
    const match = result.stdout.match(/spawned:(\d+)/);
    if (match) {
      expect(parseInt(match[1])).toBeLessThan(50);
    }
  });

  dockerIt('memory limit is enforced', async () => {
    cm = new ContainerManager(makeConfig({
      defaults: { ...getDefaults().defaults, memoryMb: 128 },
    }));
    // Try to allocate more than 128MB
    const result = await cm.exec({
      userId: 'sec-user', sessionId: 'sec-mem', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'python3 -c "x = bytearray(200*1024*1024)" 2>&1; echo "exit:$?"',
      timeout: 10,
    });
    // Should fail — OOM killed or MemoryError
    expect(result.stdout + result.stderr).toMatch(/Killed|MemoryError|exit:137|exit:1/);
  });
});
