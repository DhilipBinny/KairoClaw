import { describe, it, expect } from 'vitest';
import { configSchema } from '../config/schema.js';

describe('sandbox config schema', () => {
  it('provides defaults when sandbox section is omitted', () => {
    const parsed = configSchema.parse({});
    expect(parsed.tools.sandbox).toBeDefined();
    expect(parsed.tools.sandbox.enabled).toBe(false);
    expect(parsed.tools.sandbox.image).toBe('kairoclaw-sandbox:full');
    expect(parsed.tools.sandbox.dockerSocket).toBe('/var/run/docker.sock');
    expect(parsed.tools.sandbox.defaults.network).toBe('balanced');
    expect(parsed.tools.sandbox.defaults.workspace).toBe('read-write');
    expect(parsed.tools.sandbox.defaults.escalation).toBe('confirm');
    expect(parsed.tools.sandbox.defaults.cpu).toBe(1);
    expect(parsed.tools.sandbox.defaults.memoryMb).toBe(512);
    expect(parsed.tools.sandbox.defaults.timeoutSeconds).toBe(120);
    expect(parsed.tools.sandbox.defaults.maxLifetimeMinutes).toBe(240);
    expect(parsed.tools.sandbox.defaults.pidsLimit).toBe(256);
  });

  it('validates enabled sandbox config', () => {
    const parsed = configSchema.parse({
      tools: {
        sandbox: {
          enabled: true,
          image: 'my-custom-image:latest',
          defaults: { network: 'open', cpu: 4 },
          roles: { admin: { network: 'open', escalation: 'auto' } },
        },
      },
    });
    expect(parsed.tools.sandbox.enabled).toBe(true);
    expect(parsed.tools.sandbox.image).toBe('my-custom-image:latest');
    expect(parsed.tools.sandbox.defaults.network).toBe('open');
    expect(parsed.tools.sandbox.defaults.cpu).toBe(4);
    expect(parsed.tools.sandbox.roles.admin.network).toBe('open');
  });

  it('rejects invalid network tier', () => {
    expect(() => configSchema.parse({
      tools: { sandbox: { defaults: { network: 'invalid' } } },
    })).toThrow();
  });

  it('rejects invalid workspace mode', () => {
    expect(() => configSchema.parse({
      tools: { sandbox: { defaults: { workspace: 'invalid' } } },
    })).toThrow();
  });

  it('rejects CPU below minimum', () => {
    expect(() => configSchema.parse({
      tools: { sandbox: { defaults: { cpu: 0.1 } } },
    })).toThrow();
  });

  it('rejects memory below minimum', () => {
    expect(() => configSchema.parse({
      tools: { sandbox: { defaults: { memoryMb: 50 } } },
    })).toThrow();
  });

  it('accepts per-user overrides', () => {
    const parsed = configSchema.parse({
      tools: {
        sandbox: {
          userOverrides: {
            'user-123': { network: 'open', escalation: 'auto' },
          },
        },
      },
    });
    expect(parsed.tools.sandbox.userOverrides['user-123'].network).toBe('open');
  });

  it('preserves network allowlist defaults', () => {
    const parsed = configSchema.parse({});
    expect(parsed.tools.sandbox.networkAllowlist).toContain('registry.npmjs.org');
    expect(parsed.tools.sandbox.networkAllowlist).toContain('api.openai.com');
  });

  it('allows custom network allowlist', () => {
    const parsed = configSchema.parse({
      tools: {
        sandbox: {
          networkAllowlist: ['custom.example.com'],
        },
      },
    });
    expect(parsed.tools.sandbox.networkAllowlist).toEqual(['custom.example.com']);
  });
});
