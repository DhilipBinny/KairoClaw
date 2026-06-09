import { describe, it, expect } from 'vitest';
import {
  resolveCapabilities,
  canEscalate,
  isNetworkUpgrade,
  isWorkspaceUpgrade,
  getDefaults,
} from '../config.js';
import type { SandboxToolConfig } from '@agw/types';

function makeConfig(overrides?: Partial<SandboxToolConfig>): SandboxToolConfig {
  return { ...getDefaults(), ...overrides };
}

describe('resolveCapabilities', () => {
  it('returns defaults when no role or user overrides', () => {
    const config = makeConfig();
    const caps = resolveCapabilities(config, 'user');
    expect(caps.network).toBe('balanced');
    expect(caps.workspace).toBe('read-write');
    expect(caps.escalation).toBe('confirm');
    expect(caps.cpu).toBe(1);
    expect(caps.memoryMb).toBe(512);
    expect(caps.timeoutSeconds).toBe(120);
  });

  it('applies role overrides over defaults', () => {
    const config = makeConfig({
      roles: {
        admin: { network: 'open', workspace: 'read-write', escalation: 'auto', cpu: 2 },
      },
    });
    const caps = resolveCapabilities(config, 'admin');
    expect(caps.network).toBe('open');
    expect(caps.escalation).toBe('auto');
    expect(caps.cpu).toBe(2);
    expect(caps.memoryMb).toBe(512); // not overridden
  });

  it('applies user overrides over role overrides', () => {
    const config = makeConfig({
      roles: {
        user: { network: 'balanced', escalation: 'confirm' },
      },
      userOverrides: {
        'user-123': { network: 'open', escalation: 'auto' },
      },
    });
    const caps = resolveCapabilities(config, 'user', 'user-123');
    expect(caps.network).toBe('open');
    expect(caps.escalation).toBe('auto');
  });

  it('ignores user overrides for different userId', () => {
    const config = makeConfig({
      userOverrides: {
        'user-123': { network: 'open' },
      },
    });
    const caps = resolveCapabilities(config, 'user', 'user-456');
    expect(caps.network).toBe('balanced');
  });

  it('handles missing role gracefully', () => {
    const config = makeConfig();
    const caps = resolveCapabilities(config, 'nonexistent_role');
    expect(caps.network).toBe('balanced');
    expect(caps.workspace).toBe('read-write');
  });

  it('handles undefined userId', () => {
    const config = makeConfig();
    const caps = resolveCapabilities(config, 'user');
    expect(caps.network).toBe('balanced');
  });

  it('applies viewer role locked down', () => {
    const config = makeConfig({
      roles: {
        viewer: { network: 'locked', workspace: 'none', escalation: 'deny' },
      },
    });
    const caps = resolveCapabilities(config, 'viewer');
    expect(caps.network).toBe('locked');
    expect(caps.workspace).toBe('none');
    expect(caps.escalation).toBe('deny');
  });
});

describe('canEscalate', () => {
  it('returns allowed for auto', () => {
    expect(canEscalate('auto')).toBe('allowed');
  });

  it('returns needs_confirmation for confirm', () => {
    expect(canEscalate('confirm')).toBe('needs_confirmation');
  });

  it('returns denied for deny', () => {
    expect(canEscalate('deny')).toBe('denied');
  });
});

describe('isNetworkUpgrade', () => {
  it('detects upgrade from locked to balanced', () => {
    expect(isNetworkUpgrade('locked', 'balanced')).toBe(true);
  });

  it('detects upgrade from locked to open', () => {
    expect(isNetworkUpgrade('locked', 'open')).toBe(true);
  });

  it('detects upgrade from balanced to open', () => {
    expect(isNetworkUpgrade('balanced', 'open')).toBe(true);
  });

  it('detects no upgrade for same tier', () => {
    expect(isNetworkUpgrade('balanced', 'balanced')).toBe(false);
  });

  it('detects downgrade as non-upgrade', () => {
    expect(isNetworkUpgrade('open', 'balanced')).toBe(false);
  });
});

describe('isWorkspaceUpgrade', () => {
  it('detects upgrade from none to read-only', () => {
    expect(isWorkspaceUpgrade('none', 'read-only')).toBe(true);
  });

  it('detects upgrade from read-only to read-write', () => {
    expect(isWorkspaceUpgrade('read-only', 'read-write')).toBe(true);
  });

  it('detects no upgrade for same mode', () => {
    expect(isWorkspaceUpgrade('read-write', 'read-write')).toBe(false);
  });

  it('detects downgrade as non-upgrade', () => {
    expect(isWorkspaceUpgrade('read-write', 'read-only')).toBe(false);
  });
});

describe('getDefaults', () => {
  it('returns a complete default config', () => {
    const d = getDefaults();
    expect(d.enabled).toBe(false);
    expect(d.image).toBe('kairoclaw-sandbox:full');
    expect(d.dockerSocket).toBe('/var/run/docker.sock');
    expect(d.defaults.network).toBe('balanced');
    expect(d.defaults.workspace).toBe('read-write');
    expect(d.defaults.escalation).toBe('confirm');
    expect(d.defaults.cpu).toBe(1);
    expect(d.defaults.memoryMb).toBe(512);
    expect(d.defaults.timeoutSeconds).toBe(120);
    expect(d.defaults.maxLifetimeMinutes).toBe(240);
    expect(d.defaults.pidsLimit).toBe(256);
    expect(d.networkAllowlist.length).toBeGreaterThan(0);
    expect(d.networkAllowlist).toContain('registry.npmjs.org');
    expect(d.networkAllowlist).toContain('api.openai.com');
  });

  it('returns independent copies (no shared refs)', () => {
    const d1 = getDefaults();
    const d2 = getDefaults();
    d1.networkAllowlist.push('example.com');
    expect(d2.networkAllowlist).not.toContain('example.com');
  });
});
