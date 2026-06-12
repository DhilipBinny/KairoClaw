import type {
  SandboxToolConfig,
  SandboxCapabilities,
  SandboxNetworkTier,
  SandboxMountMode,
  SandboxEscalation,
} from '@agw/types';
import {
  DEFAULT_IMAGE,
  DEFAULT_DOCKER_SOCKET,
  DEFAULT_CPU,
  DEFAULT_MEMORY_MB,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_MAX_LIFETIME_MINUTES,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_NETWORK_ALLOWLIST,
} from './constants.js';

export function getDefaults(): SandboxToolConfig {
  return {
    enabled: false,
    image: DEFAULT_IMAGE,
    dockerSocket: DEFAULT_DOCKER_SOCKET,
    defaults: {
      network: 'balanced',
      workspace: 'read-write',
      escalation: 'confirm',
      cpu: DEFAULT_CPU,
      memoryMb: DEFAULT_MEMORY_MB,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      maxLifetimeMinutes: DEFAULT_MAX_LIFETIME_MINUTES,
      pidsLimit: DEFAULT_PIDS_LIMIT,
    },
    networkAllowlist: [...DEFAULT_NETWORK_ALLOWLIST],
    roles: {},
    userOverrides: {},
  };
}

/**
 * Resolve the effective sandbox capabilities for a given user+role.
 * Priority: userOverrides > roles > defaults.
 */
export function resolveCapabilities(
  config: SandboxToolConfig,
  role: string,
  userId?: string,
): SandboxCapabilities {
  const d = config.defaults;

  const base: SandboxCapabilities = {
    network: d.network,
    workspace: d.workspace,
    escalation: d.escalation,
    cpu: d.cpu,
    memoryMb: d.memoryMb,
    timeoutSeconds: d.timeoutSeconds,
  };

  const roleOverride = config.roles[role];
  if (roleOverride) {
    if (roleOverride.network) base.network = roleOverride.network;
    if (roleOverride.workspace) base.workspace = roleOverride.workspace;
    if (roleOverride.escalation) base.escalation = roleOverride.escalation;
    if (roleOverride.cpu != null) base.cpu = roleOverride.cpu;
    if (roleOverride.memoryMb != null) base.memoryMb = roleOverride.memoryMb;
    if (roleOverride.timeoutSeconds != null) base.timeoutSeconds = roleOverride.timeoutSeconds;
  }

  if (userId) {
    const userOverride = config.userOverrides[userId];
    if (userOverride) {
      if (userOverride.network) base.network = userOverride.network;
      if (userOverride.workspace) base.workspace = userOverride.workspace;
      if (userOverride.escalation) base.escalation = userOverride.escalation;
      if (userOverride.cpu != null) base.cpu = userOverride.cpu;
      if (userOverride.memoryMb != null) base.memoryMb = userOverride.memoryMb;
      if (userOverride.timeoutSeconds != null) base.timeoutSeconds = userOverride.timeoutSeconds;
    }
  }

  return base;
}

/**
 * Check if an escalation request (network or workspace upgrade) is allowed.
 */
export function canEscalate(
  escalation: SandboxEscalation,
): 'allowed' | 'needs_confirmation' | 'denied' {
  switch (escalation) {
    case 'auto': return 'allowed';
    case 'confirm': return 'needs_confirmation';
    case 'deny': return 'denied';
  }
}

/**
 * Check if a network tier is "higher" (more permissive) than another.
 */
export function isNetworkUpgrade(
  current: SandboxNetworkTier,
  requested: SandboxNetworkTier,
): boolean {
  const order: Record<SandboxNetworkTier, number> = { locked: 0, balanced: 1, open: 2 };
  return order[requested] > order[current];
}

/**
 * Check if a workspace mode is "higher" (more permissive) than another.
 */
export function isWorkspaceUpgrade(
  current: SandboxMountMode,
  requested: SandboxMountMode,
): boolean {
  const order: Record<SandboxMountMode, number> = { none: 0, 'read-only': 1, 'read-write': 2 };
  return order[requested] > order[current];
}
