import type {
  SandboxToolConfig,
  SandboxContainer,
  SandboxExecResult,
  SandboxCapabilities,
  SandboxNetworkTier,
  SandboxMountMode,
} from '@agw/types';
import {
  createContainer,
  execInContainer,
  removeContainer,
  listSandboxContainers,
  isDockerAvailable,
  imageExists,
} from './docker-client.js';
import { resolveMounts, toDockerBinds } from './mount-resolver.js';
import { resolveNetworkMode, buildAllowlistScript } from './network-policy.js';
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
  private containers = new Map<string, SandboxContainer>();
  private lifetimeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: SandboxToolConfig) {
    this.config = config;
  }

  updateConfig(config: SandboxToolConfig): void {
    this.config = config;
  }

  /**
   * Check if the sandbox system is ready (Docker daemon reachable + image available).
   */
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

    const caps = resolveCapabilities(this.config, opts.role, opts.userId);
    const mounts = resolveMounts({
      workspacePath: opts.workspacePath,
      scopeKey: opts.scopeKey,
      isAdmin: opts.isAdmin,
      mountMode: caps.workspace,
    });

    const networkMode = resolveNetworkMode(caps.network);
    const containerName = `${CONTAINER_PREFIX}-${sanitize(opts.userId)}-${sanitize(opts.sessionId)}`;

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
    });

    // Apply balanced-tier network allowlist if needed
    if (caps.network === 'balanced') {
      const script = buildAllowlistScript('balanced', this.config.networkAllowlist);
      if (script) {
        try {
          await execInContainer(
            this.config.dockerSocket,
            containerId,
            script,
            '/',
            10000,
          );
        } catch {
          // iptables may not be available in the container — continue without allowlist enforcement
        }
      }
    }

    const maxLifetimeMs = this.config.defaults.maxLifetimeMinutes * 60 * 1000;
    const entry: SandboxContainer = {
      containerId,
      userId: opts.userId,
      sessionId: opts.sessionId,
      image: this.config.image,
      network: caps.network,
      workspace: caps.workspace,
      createdAt: Date.now(),
      maxLifetimeMs,
    };

    this.containers.set(key, entry);

    // Auto-cleanup after max lifetime
    const timer = setTimeout(() => {
      this.destroyContainer(key).catch(() => {});
    }, maxLifetimeMs);
    this.lifetimeTimers.set(key, timer);

    return entry;
  }

  /**
   * Execute a command in the user's sandbox container.
   */
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

    return execInContainer(
      this.config.dockerSocket,
      container.containerId,
      opts.command,
      workdir,
      timeoutMs,
    );
  }

  /**
   * Get the capabilities that would apply for a user+role.
   */
  getCapabilities(role: string, userId?: string): SandboxCapabilities {
    return resolveCapabilities(this.config, role, userId);
  }

  /**
   * Destroy a specific container by user+session key.
   */
  async destroyContainer(key: string): Promise<void> {
    const entry = this.containers.get(key);
    if (!entry) return;

    const timer = this.lifetimeTimers.get(key);
    if (timer) clearTimeout(timer);
    this.lifetimeTimers.delete(key);
    this.containers.delete(key);

    await removeContainer(this.config.dockerSocket, entry.containerId);
  }

  /**
   * Destroy the sandbox for a specific session (called on session end).
   */
  async destroyForSession(userId: string, sessionId: string): Promise<void> {
    const key = this.containerKey(userId, sessionId);
    await this.destroyContainer(key);
  }

  /**
   * Destroy all sandboxes for a user (called when user is removed).
   */
  async destroyForUser(userId: string): Promise<void> {
    const keysToRemove = [...this.containers.keys()].filter(k => k.startsWith(`${userId}:`));
    await Promise.allSettled(keysToRemove.map(k => this.destroyContainer(k)));
  }

  /**
   * Destroy all managed containers (called on server shutdown).
   */
  async destroyAll(): Promise<void> {
    const keys = [...this.containers.keys()];
    await Promise.allSettled(keys.map(k => this.destroyContainer(k)));

    // Also clean up any orphaned containers from previous runs
    try {
      const orphans = await listSandboxContainers(this.config.dockerSocket);
      await Promise.allSettled(
        orphans.map(c => removeContainer(this.config.dockerSocket, c.id)),
      );
    } catch {
      // Docker not available — nothing to clean up
    }
  }

  /**
   * List all active sandbox containers.
   */
  listActive(): SandboxContainer[] {
    return [...this.containers.values()];
  }

  /**
   * Check if a container exists for a user+session.
   */
  hasContainer(userId: string, sessionId: string): boolean {
    return this.containers.has(this.containerKey(userId, sessionId));
  }

  private containerKey(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
}
