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
  getContainerIp,
} from './docker-client.js';
import { resolveMounts, toDockerBinds } from './mount-resolver.js';
import { resolveNetworkMode } from './network-policy.js';
import { resolveCapabilities } from './config.js';
import {
  CONTAINER_PREFIX,
  CONTAINER_LABEL_KEY,
  CONTAINER_USER_LABEL,
  CONTAINER_SESSION_LABEL,
  CONTAINER_WORKSPACE_PATH,
  IDLE_CLEANUP_INTERVAL_MS,
  IDLE_TIMEOUT_MS,
  MAX_CONTAINERS_PER_USER,
  MAX_CONTAINERS_TOTAL,
  DEFAULT_DESKTOP_IMAGE,
  DESKTOP_SHM_SIZE,
  DESKTOP_MEMORY_MB,
  DESKTOP_PIDS_LIMIT,
  DESKTOP_MAX_LIFETIME_MINUTES,
  DESKTOP_LABEL_KEY,
} from './constants.js';

export class ContainerManager {
  private config: SandboxToolConfig;
  private log: AgwLogger;
  private containers = new Map<string, SandboxContainer>();
  private lifetimeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingCreations = new Map<string, Promise<SandboxContainer>>();
  private idleCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private maxContainersPerUser = MAX_CONTAINERS_PER_USER;
  private maxContainersTotal = MAX_CONTAINERS_TOTAL;

  constructor(config: SandboxToolConfig, logger?: AgwLogger) {
    this.config = config;
    this.log = (logger ?? noopLogger).child({ category: 'sandbox' });
    this.startIdleCleanup();
  }

  private startIdleCleanup(): void {
    this.idleCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.containers) {
        if (now - entry.lastExecAt > IDLE_TIMEOUT_MS) {
          this.log.info({ userId: entry.userId, sessionId: entry.sessionId, idleMinutes: Math.round((now - entry.lastExecAt) / 60000) }, 'Destroying idle sandbox container');
          this.destroyContainer(key).catch(() => {});
        }
      }
    }, IDLE_CLEANUP_INTERVAL_MS);
    this.idleCleanupTimer.unref();
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

    // Balanced tier: no in-container iptables (NET_ADMIN is a security risk — users
    // can flush rules). Balanced falls back to locked (--network none) until a proxy
    // sidecar is implemented for proper domain allowlisting.
    const effectiveNetwork = caps.network === 'balanced' ? 'locked' : caps.network;
    const networkMode = resolveNetworkMode(effectiveNetwork);
    const containerName = `${CONTAINER_PREFIX}-${sanitize(opts.userId)}-${sanitize(opts.sessionId)}`;

    if (caps.network === 'balanced') {
      this.log.info({ userId: opts.userId }, 'Balanced network tier not yet implemented — falling back to locked (no network)');
    }

    this.log.info({ userId: opts.userId, sessionId: opts.sessionId, image: this.config.image, network: effectiveNetwork, workspace: caps.workspace }, 'Creating sandbox container');

    // Check per-user container limit
    const userContainers = [...this.containers.values()].filter(c => c.userId === opts.userId);
    if (userContainers.length >= this.maxContainersPerUser) {
      throw new Error(`Container limit reached (${this.maxContainersPerUser} per user). Destroy an existing session first.`);
    }
    if (this.containers.size >= this.maxContainersTotal) {
      throw new Error(`Global container limit reached (${this.maxContainersTotal}). Wait for containers to expire or ask an admin to stop some.`);
    }

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

    this.log.debug({ containerId: containerId.slice(0, 12), containerName }, 'Container started');

    const now = Date.now();
    const maxLifetimeMs = this.config.defaults.maxLifetimeMinutes * 60 * 1000;
    const entry: SandboxContainer = {
      containerId,
      userId: opts.userId,
      sessionId: opts.sessionId,
      image: this.config.image,
      network: effectiveNetwork,
      workspace: caps.workspace,
      createdAt: now,
      lastExecAt: now,
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
    container.lastExecAt = Date.now();

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

  /**
   * Read a file from inside the sandbox container.
   */
  async readFile(opts: {
    userId: string;
    sessionId: string;
    role: string;
    workspacePath: string;
    scopeKey: string | null;
    isAdmin: boolean;
    path: string;
    offset?: number;
    limit?: number;
  }): Promise<SandboxExecResult> {
    const container = await this.getOrCreate(opts);
    container.lastExecAt = Date.now();
    let cmd: string;
    if (opts.offset != null || opts.limit != null) {
      const start = (opts.offset ?? 0) + 1;
      const count = opts.limit ?? 2000;
      cmd = `sed -n '${start},${start + count - 1}p' ${escapeShellArg(opts.path)}`;
    } else {
      cmd = `head -n 2000 ${escapeShellArg(opts.path)}`;
    }
    // Prepend line count for context
    const fullCmd = `wc -l < ${escapeShellArg(opts.path)} 2>/dev/null && echo '---' && ${cmd}`;
    return execInContainer(
      this.config.dockerSocket,
      container.containerId,
      fullCmd,
      '/',
      10000,
    );
  }

  /**
   * Write content to a file inside the sandbox container.
   * Uses base64 encoding to safely transfer content without shell escaping issues.
   */
  async writeFile(opts: {
    userId: string;
    sessionId: string;
    role: string;
    workspacePath: string;
    scopeKey: string | null;
    isAdmin: boolean;
    path: string;
    content: string;
  }): Promise<SandboxExecResult> {
    const container = await this.getOrCreate(opts);
    container.lastExecAt = Date.now();
    const dir = opts.path.substring(0, opts.path.lastIndexOf('/'));
    const b64 = Buffer.from(opts.content, 'utf8').toString('base64');
    const mkdirCmd = dir ? `mkdir -p ${escapeShellArg(dir)} && ` : '';
    return execInContainer(
      this.config.dockerSocket,
      container.containerId,
      `${mkdirCmd}echo '${b64}' | base64 -d > ${escapeShellArg(opts.path)}`,
      '/',
      10000,
    );
  }

  /**
   * List files in a directory inside the sandbox container.
   */
  async listFiles(opts: {
    userId: string;
    sessionId: string;
    role: string;
    workspacePath: string;
    scopeKey: string | null;
    isAdmin: boolean;
    path: string;
  }): Promise<SandboxExecResult> {
    const container = await this.getOrCreate(opts);
    container.lastExecAt = Date.now();
    return execInContainer(
      this.config.dockerSocket,
      container.containerId,
      `ls -la ${escapeShellArg(opts.path)}`,
      '/',
      10000,
    );
  }

  // ── Desktop container management ─────────────────────

  /**
   * Check if a user has desktop mode enabled.
   */
  isDesktopEnabled(userId: string): boolean {
    const desktopUsers = (this.config as any).desktopUsers as string[] | undefined;
    return Array.isArray(desktopUsers) && desktopUsers.includes(userId);
  }

  /**
   * Get or create a persistent desktop container for a user.
   * Desktop containers are keyed by userId only (not session),
   * use the desktop image, and have higher resource limits.
   */
  async getOrCreateDesktop(opts: {
    userId: string;
    workspacePath: string;
    scopeKey: string | null;
    isAdmin: boolean;
  }): Promise<SandboxContainer> {
    const key = `desktop:${opts.userId}`;

    const existing = this.containers.get(key);
    if (existing) return existing;

    const pending = this.pendingCreations.get(key);
    if (pending) return pending;

    const promise = this._doCreateDesktop(key, opts);
    this.pendingCreations.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pendingCreations.delete(key);
    }
  }

  private async _doCreateDesktop(key: string, opts: {
    userId: string;
    workspacePath: string;
    scopeKey: string | null;
    isAdmin: boolean;
  }): Promise<SandboxContainer> {
    const mounts = resolveMounts({
      workspacePath: opts.workspacePath,
      scopeKey: opts.scopeKey,
      isAdmin: opts.isAdmin,
      mountMode: 'read-write',
    });

    const desktopImage = (this.config as any).desktopImage || DEFAULT_DESKTOP_IMAGE;
    const networkMode = resolveNetworkMode('open');
    const containerName = `${CONTAINER_PREFIX}-desktop-${sanitize(opts.userId)}`;

    this.log.info({ userId: opts.userId, image: desktopImage }, 'Creating desktop container');

    const containerId = await createContainer({
      socketPath: this.config.dockerSocket,
      name: containerName,
      image: desktopImage,
      binds: toDockerBinds(mounts.binds),
      workdir: mounts.workdir,
      networkMode,
      labels: {
        [CONTAINER_LABEL_KEY]: 'true',
        [CONTAINER_USER_LABEL]: opts.userId,
        [CONTAINER_SESSION_LABEL]: 'desktop',
        [DESKTOP_LABEL_KEY]: 'true',
      },
      cpu: this.config.defaults.cpu,
      memoryMb: DESKTOP_MEMORY_MB,
      pidsLimit: DESKTOP_PIDS_LIMIT,
      shmSize: DESKTOP_SHM_SIZE,
    });

    const containerIp = await getContainerIp(this.config.dockerSocket, containerId);

    this.log.debug({ containerId: containerId.slice(0, 12), containerName, containerIp }, 'Desktop container started');

    const now = Date.now();
    const maxLifetimeMs = DESKTOP_MAX_LIFETIME_MINUTES * 60 * 1000;
    const entry: SandboxContainer = {
      containerId,
      userId: opts.userId,
      sessionId: 'desktop',
      image: desktopImage,
      network: 'open',
      workspace: 'read-write',
      createdAt: now,
      lastExecAt: now,
      maxLifetimeMs,
      desktop: true,
      containerIp: containerIp || undefined,
    };

    this.containers.set(key, entry);

    const timer = setTimeout(() => {
      this.destroyContainer(key).catch(() => {});
    }, maxLifetimeMs);
    timer.unref();
    this.lifetimeTimers.set(key, timer);

    return entry;
  }

  /**
   * Get an existing desktop container for a user (without creating).
   */
  getDesktopContainer(userId: string): SandboxContainer | null {
    return this.containers.get(`desktop:${userId}`) || null;
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
    if (this.idleCleanupTimer) {
      clearInterval(this.idleCleanupTimer);
      this.idleCleanupTimer = null;
    }
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

function escapeShellArg(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function sanitize(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  if (!cleaned) {
    return 'h' + createHash('sha256').update(s).digest('hex').slice(0, 11);
  }
  return cleaned;
}
