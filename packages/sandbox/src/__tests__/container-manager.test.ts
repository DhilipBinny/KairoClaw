import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDefaults } from '../config.js';
import type { SandboxToolConfig, SandboxExecResult } from '@agw/types';

const mockIsDockerAvailable = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
const mockImageExists = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
const mockCreateContainer = vi.fn<() => Promise<string>>().mockResolvedValue('container-id-123');
const mockExecInContainer = vi.fn<() => Promise<SandboxExecResult>>().mockResolvedValue({ exitCode: 0, stdout: 'hello', stderr: '' });
const mockRemoveContainer = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockListSandboxContainers = vi.fn().mockResolvedValue([]);

vi.mock('../docker-client.js', () => ({
  isDockerAvailable: (...args: unknown[]) => mockIsDockerAvailable(...args as []),
  imageExists: (...args: unknown[]) => mockImageExists(...args as []),
  createContainer: (...args: unknown[]) => mockCreateContainer(...args as []),
  execInContainer: (...args: unknown[]) => mockExecInContainer(...args as []),
  removeContainer: (...args: unknown[]) => mockRemoveContainer(...args as []),
  listSandboxContainers: (...args: unknown[]) => mockListSandboxContainers(...args as []),
  getContainerIp: vi.fn().mockResolvedValue(null),
  getContainerPorts: vi.fn().mockResolvedValue({}),
  detectAppNetwork: vi.fn().mockResolvedValue(null),
  connectToNetwork: vi.fn().mockResolvedValue(undefined),
  getContainerIpOnNetwork: vi.fn().mockResolvedValue(null),
  getDocker: vi.fn(),
  resetDocker: vi.fn(),
}));

const { ContainerManager } = await import('../container-manager.js');

let tmpDir: string;

function makeConfig(overrides?: Partial<SandboxToolConfig>): SandboxToolConfig {
  return { ...getDefaults(), enabled: true, ...overrides };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-cm-'));
  fs.mkdirSync(path.join(tmpDir, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'IDENTITY.md'), '# Agent');
  fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '# Soul');
  fs.writeFileSync(path.join(tmpDir, 'RULES.md'), '# Rules');
  vi.clearAllMocks();
  mockCreateContainer.mockResolvedValue('container-id-123');
  mockExecInContainer.mockResolvedValue({ exitCode: 0, stdout: 'hello', stderr: '' });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ContainerManager', () => {
  it('creates a container on first exec', async () => {
    const cm = new ContainerManager(makeConfig());
    const result = await cm.exec({
      userId: 'user-1', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo hello',
    });

    expect(mockCreateContainer).toHaveBeenCalledOnce();
    expect(mockExecInContainer).toHaveBeenCalledOnce();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
  });

  it('reuses container on second exec for same user+session', async () => {
    const cm = new ContainerManager(makeConfig());
    await cm.exec({
      userId: 'user-1', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo one',
    });
    await cm.exec({
      userId: 'user-1', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo two',
    });

    expect(mockCreateContainer).toHaveBeenCalledOnce();
    expect(mockExecInContainer).toHaveBeenCalledTimes(2);
  });

  it('creates separate containers for different sessions', async () => {
    const cm = new ContainerManager(makeConfig());
    await cm.exec({
      userId: 'user-1', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo one',
    });
    mockCreateContainer.mockResolvedValueOnce('container-id-456');
    await cm.exec({
      userId: 'user-1', sessionId: 'sess-2', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo two',
    });

    expect(mockCreateContainer).toHaveBeenCalledTimes(2);
  });

  it('creates separate containers for different users', async () => {
    const cm = new ContainerManager(makeConfig());
    await cm.exec({
      userId: 'user-1', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo one',
    });
    mockCreateContainer.mockResolvedValueOnce('container-id-456');
    await cm.exec({
      userId: 'user-2', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-2', isAdmin: false,
      command: 'echo two',
    });

    expect(mockCreateContainer).toHaveBeenCalledTimes(2);
  });

  it('applies admin role config (open network)', async () => {
    const config = makeConfig({
      roles: { admin: { network: 'open', escalation: 'auto' } },
    });
    const cm = new ContainerManager(config);
    await cm.exec({
      userId: 'admin-1', sessionId: 'sess-1', role: 'admin',
      workspacePath: tmpDir, scopeKey: null, isAdmin: true,
      command: 'echo admin',
    });

    expect(mockCreateContainer).toHaveBeenCalledOnce();
    const callArgs = mockCreateContainer.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.networkMode).toBe('bridge');
  });

  it('applies locked network (none)', async () => {
    const config = makeConfig({
      roles: { viewer: { network: 'locked' } },
    });
    const cm = new ContainerManager(config);
    await cm.exec({
      userId: 'viewer-1', sessionId: 'sess-1', role: 'viewer',
      workspacePath: tmpDir, scopeKey: 'viewer-1', isAdmin: false,
      command: 'echo locked',
    });

    const callArgs = mockCreateContainer.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.networkMode).toBe('none');
  });

  it('destroyForSession removes the right container', async () => {
    const cm = new ContainerManager(makeConfig());
    await cm.exec({
      userId: 'user-1', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo hello',
    });

    expect(cm.hasContainer('user-1', 'sess-1')).toBe(true);
    await cm.destroyForSession('user-1', 'sess-1');
    expect(cm.hasContainer('user-1', 'sess-1')).toBe(false);
    expect(mockRemoveContainer).toHaveBeenCalledOnce();
  });

  it('destroyForUser removes all containers for that user', async () => {
    const cm = new ContainerManager(makeConfig());
    mockCreateContainer.mockResolvedValueOnce('c1').mockResolvedValueOnce('c2');
    await cm.exec({
      userId: 'user-1', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo one',
    });
    await cm.exec({
      userId: 'user-1', sessionId: 'sess-2', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo two',
    });

    expect(cm.listActive()).toHaveLength(2);
    await cm.destroyForUser('user-1');
    expect(cm.listActive()).toHaveLength(0);
    expect(mockRemoveContainer).toHaveBeenCalledTimes(2);
  });

  it('destroyAll cleans up all containers + orphans', async () => {
    const cm = new ContainerManager(makeConfig());
    mockCreateContainer.mockResolvedValueOnce('c1');
    await cm.exec({
      userId: 'user-1', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo hello',
    });

    mockListSandboxContainers.mockResolvedValueOnce([
      { id: 'orphan-1', name: 'kairoclaw-sandbox-old', state: 'exited', labels: {} },
    ]);

    await cm.destroyAll();
    expect(cm.listActive()).toHaveLength(0);
    expect(mockRemoveContainer).toHaveBeenCalledTimes(2);
  });

  it('listActive returns active containers', async () => {
    const cm = new ContainerManager(makeConfig());
    expect(cm.listActive()).toHaveLength(0);

    await cm.exec({
      userId: 'user-1', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo hello',
    });

    const active = cm.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].userId).toBe('user-1');
    expect(active[0].sessionId).toBe('sess-1');
  });

  it('isReady returns ready when enabled + docker + image', async () => {
    const cm = new ContainerManager(makeConfig());
    mockIsDockerAvailable.mockResolvedValueOnce(true);
    mockImageExists.mockResolvedValueOnce(true);
    const r = await cm.isReady();
    expect(r.ready).toBe(true);
  });

  it('isReady returns not ready when disabled', async () => {
    const cm = new ContainerManager(makeConfig({ enabled: false }));
    const r = await cm.isReady();
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('disabled');
  });

  it('passes resource limits to createContainer', async () => {
    const config = makeConfig({
      defaults: {
        ...getDefaults().defaults,
        cpu: 2,
        memoryMb: 1024,
        pidsLimit: 512,
      },
    });
    const cm = new ContainerManager(config);
    await cm.exec({
      userId: 'user-1', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo hello',
    });

    const callArgs = mockCreateContainer.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.cpu).toBe(2);
    expect(callArgs.memoryMb).toBe(1024);
    expect(callArgs.pidsLimit).toBe(512);
  });

  it('uses custom timeout from exec args', async () => {
    const cm = new ContainerManager(makeConfig());
    await cm.exec({
      userId: 'user-1', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo hello',
      timeout: 60,
    });

    const callArgs = mockExecInContainer.mock.calls[0];
    expect(callArgs[4]).toBe(60000);
  });

  it('uses custom workdir from exec args', async () => {
    const cm = new ContainerManager(makeConfig());
    await cm.exec({
      userId: 'user-1', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'user-1', isAdmin: false,
      command: 'echo hello',
      workdir: '/tmp',
    });

    const callArgs = mockExecInContainer.mock.calls[0];
    expect(callArgs[3]).toBe('/tmp');
  });
});
