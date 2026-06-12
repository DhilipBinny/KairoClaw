import { createHash } from 'node:crypto';
import type {
  SandboxToolConfig,
  SandboxContainer,
  SandboxExecResult,
  SandboxCapabilities,
  AgwLogger,
} from '@agw/types';
import { noopLogger } from '@agw/types';
import {
  createContainer,
  execInContainer,
  removeContainer,
  listSandboxContainers,
  isDockerAvailable,
  imageExists,
} from './docker-client.js';
import { resolveMounts, toDockerBinds } from './mount-resolver.js';
import { resolveNetworkMode, buildAllowlistScript, needsIptables } from './network-policy.js';
import { resolveCapabilities } from './config.js';
import {
  CONTAINER_PREFIX,
  CONTAINER_LABEL_KEY,
  CONTAINER_USER_LABEL,
  CONTAINER_SESSION_LABEL,
  CONTAINER_WORKSPACE_PATH,
} from './constants.js';

export class ContainerManager {
  private config: SandboxToolConfig;
  private log: AgwLogger;
  private containers = new Map<string, SandboxContainer>();
  private lifetimeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingCreations = new Map<string, Promise<SandboxContainer>>();

  constructor(config: SandboxToolConfig, logger?: AgwLogger) {
    this.config = config;
    this.log = (logger ?? noopLogger).child({ category: 'sandbox' });
  }

  updateConfig(config: SandboxToolConfig): void {
    this.config = config;
  }

  async isReady(): Promise<{ ready: boolean; reason?: string }> {
    if (!this.config.enabled) {
      return { ready: false, reason: 'Sandbox is disabled in config' };
    }

    const dockerOk = await isDockerAvailable(this.config.dockerSocket);
    if (!dockerOk) {
      return { ready: false, reason: `Docker daemon not reachable at ${this.config.dockerSocket}` };
    }

    const imgOk = await imageExists(this.config.dockerSocket, this.config.image);
    if (!imgOk) {
      return { ready: false, reason: `Sandbox image '${this.config.image}' not found. Pull or build it first.` };
    }

    return { ready: true };
  }

  /**
   * Get or create a sandbox container for a user+session.
   * Uses a per-key promise lock to prevent duplicate container creation
   * from concurrent requests.
   */
  async getOrCreate(opts: {
    userId: string;
    sessionId: string;
    role: string;
    workspacePath: string;
    scopeKey: string | null;
    isAdmin: boolean;
  }): Promise<SandboxContainer> {
    const key = this.containerKey(opts.userId, opts.sessionId);

    const existing = this.containers.get(key);
    if (existing) return existing;

    const pending = this.pendingCreations.get(key);
    if (pending) return pending;

    const promise = this._doCreate(key, opts);
    this.pendingCreations.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pendingCreations.delete(key);
    }
  }

  private async _doCreate(key: string, opts: {
    userId: string;
    sessionId: string;
    role: string;
    workspacePath: string;
    scopeKey: string | null;
    isAdmin: boolean;
  }): Promise<SandboxContainer> {
    const caps = resolveCapabilities(this.config, opts.role, opts.userId);
    const mounts = resolveMounts({
      workspacePath: opts.workspacePath,
      scopeKey: opts.scopeKey,
      isAdmin: opts.isAdmin,
      mountMode: caps.workspace,
    });

    const networkMode = resolveNetworkMode(caps.network);
    const containerName = `${CONTAINER_PREFIX}-${sanitize(opts.userId)}-${sanitize(opts.sessionId)}`;
    const wantsIptables = needsIptables(caps.network, this.config.networkAllowlist);

    this.log.info({ userId: opts.userId, sessionId: opts.sessionId, image: this.config.image, network: caps.network, workspace: caps.workspace }, 'Creating sandbox container');

    const containerId = await createContainer({
      socketPath: this.config.dockerSocket,
      name: containerName,
      image: this.config.image,
      binds: toDockerBinds(mounts.binds),
      workdir: mounts.workdir,
      networkMode,
      labels: {
        [CONTAINER_LABEL_KEY]: 'true',
        [CONTAINER_USER_LABEL]: opts.userId,
        [CONTAINER_SESSION_LABEL]: opts.sessionId,
      },
      cpu: caps.cpu ?? this.config.defaults.cpu,
      memoryMb: caps.memoryMb ?? this.config.defaults.memoryMb,
      pidsLimit: this.config.defaults.pidsLimit,
      addNetAdmin: wantsIptables,
    });

    this.log.debug({ containerId: containerId.slice(0, 12), containerName }, 'Container started');

    let effectiveNetwork = caps.network;

    if (wantsIptables) {
      try {
        const script = buildAllowlistScript(caps.network, this.config.networkAllowlist);
        if (script) {
          const result = await execInContainer(
            this.config.dockerSocket,
            containerId,
            script,
            '/',
            10000,
          );
          if (result.exitCode !== 0) {
            this.log.warn({ exitCode: result.exitCode, containerId: containerId.slice(0, 12) }, 'iptables allowlist failed — container has unrestricted network');
            effectiveNetwork = 'open';
          }
        }
      } catch (err) {
        this.log.error({ containerId: containerId.slice(0, 12), err: (err as Error).message }, 'iptables exec threw — removing orphan container');
        await removeContainer(this.config.dockerSocket, containerId).catch(() => {});
        throw err;
      }
    }

    const maxLifetimeMs = this.config.defaults.maxLifetimeMinutes * 60 * 1000;
    const entry: SandboxContainer = {
      containerId,
      userId: opts.userId,
      sessionId: opts.sessionId,
      image: this.config.image,
      network: effectiveNetwork,
      workspace: caps.workspace,
      createdAt: Date.now(),
      maxLifetimeMs,
    };

    this.containers.set(key, entry);

    const timer = setTimeout(() => {
      this.destroyContainer(key).catch(() => {});
    }, maxLifetimeMs);
    timer.unref();
    this.lifetimeTimers.set(key, timer);

    return entry;
  }

  async exec(opts: {
    userId: string;
    sessionId: string;
    role: string;
    workspacePath: string;
    scopeKey: string | null;
    isAdmin: boolean;
    command: string;
    workdir?: string;
    timeout?: number;
  }): Promise<SandboxExecResult> {
    const container = await this.getOrCreate(opts);
    const caps = resolveCapabilities(this.config, opts.role, opts.userId);
    const timeoutMs = (opts.timeout ?? caps.timeoutSeconds ?? this.config.defaults.timeoutSeconds) * 1000;
    const workdir = opts.workdir ?? CONTAINER_WORKSPACE_PATH;

    this.log.debug({ userId: opts.userId, command: opts.command.slice(0, 100), timeoutMs }, 'Sandbox exec');

    const result = await execInContainer(
      this.config.dockerSocket,
      container.containerId,
      opts.command,
      workdir,
      timeoutMs,
    );

    this.log.debug({ userId: opts.userId, exitCode: result.exitCode }, 'Sandbox exec complete');
    return result;
  }

  getCapabilities(role: string, userId?: string): SandboxCapabilities {
    return resolveCapabilities(this.config, role, userId);
  }

  async destroyContainer(key: string): Promise<void> {
    const entry = this.containers.get(key);
    if (!entry) return;

    const timer = this.lifetimeTimers.get(key);
    if (timer) clearTimeout(timer);
    this.lifetimeTimers.delete(key);
    this.containers.delete(key);

    this.log.info({ userId: entry.userId, sessionId: entry.sessionId, containerId: entry.containerId.slice(0, 12) }, 'Destroying sandbox container');
    await removeContainer(this.config.dockerSocket, entry.containerId);
  }

  async destroyForSession(userId: string, sessionId: string): Promise<void> {
    const key = this.containerKey(userId, sessionId);
    await this.destroyContainer(key);
  }

  async destroyForUser(userId: string): Promise<void> {
    const keysToRemove = [...this.containers.keys()].filter(k => k.startsWith(`${userId}:`));
    await Promise.allSettled(keysToRemove.map(k => this.destroyContainer(k)));
  }

  async destroyAll(): Promise<void> {
    const count = this.containers.size;
    if (count > 0) this.log.info({ count }, 'Destroying all sandbox containers');
    const keys = [...this.containers.keys()];
    await Promise.allSettled(keys.map(k => this.destroyContainer(k)));

    try {
      const orphans = await listSandboxContainers(this.config.dockerSocket);
      if (orphans.length > 0) {
        this.log.warn({ count: orphans.length }, 'Cleaning up orphan sandbox containers');
        await Promise.allSettled(
          orphans.map(c => removeContainer(this.config.dockerSocket, c.id)),
        );
      }
    } catch {
      // Docker not available
    }
  }

  listActive(): SandboxContainer[] {
    return [...this.containers.values()];
  }

  hasContainer(userId: string, sessionId: string): boolean {
    return this.containers.has(this.containerKey(userId, sessionId));
  }

  private containerKey(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
  }
}

function sanitize(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  if (!cleaned) {
    return 'h' + createHash('sha256').update(s).digest('hex').slice(0, 11);
  }
  return cleaned;
}
