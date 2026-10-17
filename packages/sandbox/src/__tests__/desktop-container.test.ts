import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDefaults } from '../config.js';
import type { SandboxToolConfig, SandboxExecResult } from '@agw/types';

const mockCreateContainer = vi.fn<() => Promise<string>>().mockResolvedValue('desktop-container-1');
const mockExecInContainer = vi.fn<() => Promise<SandboxExecResult>>().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
const mockRemoveContainer = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockGetContainerIp = vi.fn<() => Promise<string | null>>().mockResolvedValue('172.17.0.5');
const mockGetContainerPorts = vi.fn<() => Promise<Record<string, number>>>().mockResolvedValue({
  '6080/tcp': 32768,
  '7681/tcp': 32769,
  '8090/tcp': 32770,
});
const mockListSandboxContainers = vi.fn().mockResolvedValue([]);

vi.mock('../docker-client.js', () => ({
  isDockerAvailable: vi.fn().mockResolvedValue(true),
  imageExists: vi.fn().mockResolvedValue(true),
  createContainer: (...args: unknown[]) => mockCreateContainer(...args as []),
  execInContainer: (...args: unknown[]) => mockExecInContainer(...args as []),
  removeContainer: (...args: unknown[]) => mockRemoveContainer(...args as []),
  listSandboxContainers: (...args: unknown[]) => mockListSandboxContainers(...args as []),
  getContainerIp: (...args: unknown[]) => mockGetContainerIp(...args as []),
  getContainerPorts: (...args: unknown[]) => mockGetContainerPorts(...args as []),
  getDocker: vi.fn(),
  resetDocker: vi.fn(),
}));

const { ContainerManager } = await import('../container-manager.js');

let tmpDir: string;

function makeConfig(overrides?: Partial<SandboxToolConfig>): SandboxToolConfig {
  return {
    ...getDefaults(),
    enabled: true,
    desktopUsers: ['alice', 'bob'],
    ...overrides,
  } as SandboxToolConfig;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-desktop-'));
  fs.mkdirSync(path.join(tmpDir, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'IDENTITY.md'), '# Agent');
  fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '# Soul');
  fs.writeFileSync(path.join(tmpDir, 'RULES.md'), '# Rules');
  vi.clearAllMocks();
  mockCreateContainer.mockResolvedValue('desktop-container-1');
  mockGetContainerIp.mockResolvedValue('172.17.0.5');
  mockGetContainerPorts.mockResolvedValue({ '6080/tcp': 32768, '7681/tcp': 32769, '8090/tcp': 32770 });
  mockExecInContainer.mockResolvedValue({
    exitCode: 0,
    stdout: '{"vncPassword":"testpw","sessionToken":"testtoken"}',
    stderr: '',
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Desktop container management', () => {
  it('isDesktopEnabled returns true for users in desktopUsers list', () => {
    const cm = new ContainerManager(makeConfig());
    expect(cm.isDesktopEnabled('alice')).toBe(true);
    expect(cm.isDesktopEnabled('bob')).toBe(true);
    expect(cm.isDesktopEnabled('charlie')).toBe(false);
  });

  it('isDesktopEnabled returns false when desktopUsers is not set', () => {
    const cm = new ContainerManager(makeConfig({ desktopUsers: undefined } as any));
    expect(cm.isDesktopEnabled('alice')).toBe(false);
  });

  it('getOrCreateDesktop creates a desktop container', async () => {
    const cm = new ContainerManager(makeConfig());
    const container = await cm.getOrCreateDesktop({
      userId: 'alice',
      workspacePath: tmpDir,
      scopeKey: null,
      isAdmin: true,
    });

    expect(mockCreateContainer).toHaveBeenCalledOnce();
    expect(container.desktop).toBe(true);
    expect(container.userId).toBe('alice');
    expect(container.sessionId).toBe('desktop');
    expect(container.containerIp).toBe('172.17.0.5');
    expect(container.hostPorts).toEqual({ '6080/tcp': 32768, '7681/tcp': 32769, '8090/tcp': 32770 });
  });

  it('getOrCreateDesktop reads secrets from the container', async () => {
    const cm = new ContainerManager(makeConfig());
    const container = await cm.getOrCreateDesktop({
      userId: 'alice',
      workspacePath: tmpDir,
      scopeKey: null,
      isAdmin: true,
    });

    expect(container.desktopSecrets).toEqual({
      vncPassword: 'testpw',
      sessionToken: 'testtoken',
    });
  });

  it('getOrCreateDesktop reuses existing desktop container', async () => {
    const cm = new ContainerManager(makeConfig());
    const first = await cm.getOrCreateDesktop({
      userId: 'alice', workspacePath: tmpDir, scopeKey: null, isAdmin: true,
    });
    const second = await cm.getOrCreateDesktop({
      userId: 'alice', workspacePath: tmpDir, scopeKey: null, isAdmin: true,
    });

    expect(mockCreateContainer).toHaveBeenCalledOnce();
    expect(first.containerId).toBe(second.containerId);
  });

  it('getOrCreateDesktop creates separate containers per user', async () => {
    const cm = new ContainerManager(makeConfig());
    mockCreateContainer.mockResolvedValueOnce('desktop-alice').mockResolvedValueOnce('desktop-bob');

    await cm.getOrCreateDesktop({
      userId: 'alice', workspacePath: tmpDir, scopeKey: null, isAdmin: true,
    });
    await cm.getOrCreateDesktop({
      userId: 'bob', workspacePath: tmpDir, scopeKey: null, isAdmin: true,
    });

    expect(mockCreateContainer).toHaveBeenCalledTimes(2);
  });

  it('getOrCreateDesktop passes port bindings to createContainer', async () => {
    const cm = new ContainerManager(makeConfig());
    await cm.getOrCreateDesktop({
      userId: 'alice', workspacePath: tmpDir, scopeKey: null, isAdmin: true,
    });

    const callArgs = mockCreateContainer.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.portBindings).toBeDefined();
    const bindings = callArgs.portBindings as Record<string, unknown>;
    expect(bindings['6080/tcp']).toBeDefined();
    expect(bindings['7681/tcp']).toBeDefined();
    expect(bindings['8090/tcp']).toBeDefined();
  });

  it('getOrCreateDesktop does not pass cmd (uses image CMD)', async () => {
    const cm = new ContainerManager(makeConfig());
    await cm.getOrCreateDesktop({
      userId: 'alice', workspacePath: tmpDir, scopeKey: null, isAdmin: true,
    });

    const callArgs = mockCreateContainer.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.cmd).toBeUndefined();
  });

  it('getDesktopContainer returns null when no desktop exists', () => {
    const cm = new ContainerManager(makeConfig());
    expect(cm.getDesktopContainer('alice')).toBeNull();
  });

  it('getDesktopContainer returns the container after creation', async () => {
    const cm = new ContainerManager(makeConfig());
    await cm.getOrCreateDesktop({
      userId: 'alice', workspacePath: tmpDir, scopeKey: null, isAdmin: true,
    });

    const container = cm.getDesktopContainer('alice');
    expect(container).not.toBeNull();
    expect(container!.desktop).toBe(true);
    expect(container!.userId).toBe('alice');
  });

  it('desktopExec executes command in the desktop container', async () => {
    const cm = new ContainerManager(makeConfig());
    await cm.getOrCreateDesktop({
      userId: 'alice', workspacePath: tmpDir, scopeKey: null, isAdmin: true,
    });

    mockExecInContainer.mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '' });
    const result = await cm.desktopExec('alice', 'echo ok', 5);
    expect(result.stdout).toBe('ok');
  });

  it('desktopExec throws when no desktop container running', async () => {
    const cm = new ContainerManager(makeConfig());
    await expect(cm.desktopExec('alice', 'echo hi')).rejects.toThrow('No desktop container running');
  });

  it('destroyForUser also destroys desktop containers', async () => {
    const cm = new ContainerManager(makeConfig());
    mockCreateContainer.mockResolvedValueOnce('sandbox-1').mockResolvedValueOnce('desktop-1');

    await cm.exec({
      userId: 'alice', sessionId: 'sess-1', role: 'user',
      workspacePath: tmpDir, scopeKey: 'alice', isAdmin: false,
      command: 'echo hello',
    });
    await cm.getOrCreateDesktop({
      userId: 'alice', workspacePath: tmpDir, scopeKey: null, isAdmin: true,
    });

    expect(cm.listActive()).toHaveLength(2);
    await cm.destroyForUser('alice');
    expect(cm.listActive()).toHaveLength(0);
    expect(mockRemoveContainer).toHaveBeenCalledTimes(2);
  });

  it('getOrCreateDesktop enforces per-user container limit', async () => {
    const config = makeConfig();
    const cm = new ContainerManager(config);

    for (let i = 0; i < 5; i++) {
      mockCreateContainer.mockResolvedValueOnce(`container-${i}`);
      await cm.exec({
        userId: 'alice', sessionId: `sess-${i}`, role: 'user',
        workspacePath: tmpDir, scopeKey: 'alice', isAdmin: false,
        command: 'echo hello',
      });
    }

    await expect(cm.getOrCreateDesktop({
      userId: 'alice', workspacePath: tmpDir, scopeKey: null, isAdmin: true,
    })).rejects.toThrow('Container limit reached');
  });

  it('getOrCreateDesktop cleans up on inspection failure', async () => {
    const cm = new ContainerManager(makeConfig());
    mockGetContainerPorts.mockRejectedValueOnce(new Error('inspect failed'));

    await expect(cm.getOrCreateDesktop({
      userId: 'alice', workspacePath: tmpDir, scopeKey: null, isAdmin: true,
    })).rejects.toThrow('inspection failed');

    expect(mockRemoveContainer).toHaveBeenCalledOnce();
    expect(cm.getDesktopContainer('alice')).toBeNull();
  });

  it('desktop container uses open network mode', async () => {
    const cm = new ContainerManager(makeConfig());
    await cm.getOrCreateDesktop({
      userId: 'alice', workspacePath: tmpDir, scopeKey: null, isAdmin: true,
    });

    const callArgs = mockCreateContainer.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.networkMode).toBe('bridge');
  });

  it('desktop container uses higher memory limit', async () => {
    const cm = new ContainerManager(makeConfig());
    await cm.getOrCreateDesktop({
      userId: 'alice', workspacePath: tmpDir, scopeKey: null, isAdmin: true,
    });

    const callArgs = mockCreateContainer.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.memoryMb).toBe(1024);
    expect(callArgs.shmSize).toBe(256 * 1024 * 1024);
  });
});
