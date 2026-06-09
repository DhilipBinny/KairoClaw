/**
 * Sandbox execution types.
 *
 * Defines configuration and runtime interfaces for Docker-based
 * sandboxed code execution (sandbox_exec tool).
 */

// ──────────────────────────────────────────────
// Enums / string unions
// ──────────────────────────────────────────────

export type SandboxNetworkTier = 'open' | 'balanced' | 'locked';

export type SandboxMountMode = 'read-write' | 'read-only' | 'none';

export type SandboxEscalation = 'auto' | 'confirm' | 'deny';

// ──────────────────────────────────────────────
// Per-role / per-user capability overrides
// ──────────────────────────────────────────────

export interface SandboxCapabilities {
  network: SandboxNetworkTier;
  workspace: SandboxMountMode;
  escalation: SandboxEscalation;
  cpu?: number;
  memoryMb?: number;
  timeoutSeconds?: number;
}

// ──────────────────────────────────────────────
// Config schema shape (mirrors Zod in core)
// ──────────────────────────────────────────────

export interface SandboxDefaults {
  network: SandboxNetworkTier;
  workspace: SandboxMountMode;
  escalation: SandboxEscalation;
  cpu: number;
  memoryMb: number;
  timeoutSeconds: number;
  maxLifetimeMinutes: number;
  pidsLimit: number;
}

export interface SandboxToolConfig {
  enabled: boolean;
  image: string;
  dockerSocket: string;
  defaults: SandboxDefaults;
  networkAllowlist: string[];
  roles: Record<string, Partial<SandboxCapabilities>>;
  userOverrides: Record<string, Partial<SandboxCapabilities>>;
}

// ──────────────────────────────────────────────
// Runtime container state
// ──────────────────────────────────────────────

export interface SandboxContainer {
  containerId: string;
  userId: string;
  sessionId: string;
  image: string;
  network: SandboxNetworkTier;
  workspace: SandboxMountMode;
  createdAt: number;
  maxLifetimeMs: number;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
