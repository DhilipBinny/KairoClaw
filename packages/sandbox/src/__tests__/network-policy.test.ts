import { describe, it, expect } from 'vitest';
import { resolveNetworkMode, buildAllowlistScript } from '../network-policy.js';

describe('resolveNetworkMode', () => {
  it('returns bridge for open tier', () => {
    expect(resolveNetworkMode('open')).toBe('bridge');
  });

  it('returns bridge for balanced tier', () => {
    expect(resolveNetworkMode('balanced')).toBe('bridge');
  });

  it('returns none for locked tier', () => {
    expect(resolveNetworkMode('locked')).toBe('none');
  });
});

describe('buildAllowlistScript', () => {
  it('returns null for open tier', () => {
    expect(buildAllowlistScript('open', ['example.com'])).toBeNull();
  });

  it('returns null for locked tier', () => {
    expect(buildAllowlistScript('locked', ['example.com'])).toBeNull();
  });

  it('returns null for balanced with empty allowlist', () => {
    expect(buildAllowlistScript('balanced', [])).toBeNull();
  });

  it('builds iptables script for balanced tier with domains', () => {
    const script = buildAllowlistScript('balanced', ['registry.npmjs.org', 'api.openai.com']);
    expect(script).not.toBeNull();
    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('iptables -A OUTPUT -o lo -j ACCEPT');
    expect(script).toContain('iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT');
    expect(script).toContain('registry.npmjs.org');
    expect(script).toContain('api.openai.com');
    expect(script).toContain('iptables -A OUTPUT -j DROP');
  });

  it('allows DNS resolution in balanced mode', () => {
    const script = buildAllowlistScript('balanced', ['example.com'])!;
    expect(script).toContain('--dport 53');
  });

  it('uses getent for domain resolution', () => {
    const script = buildAllowlistScript('balanced', ['pypi.org'])!;
    expect(script).toContain('getent hosts pypi.org');
  });

  it('drops all other traffic at the end', () => {
    const script = buildAllowlistScript('balanced', ['x.com'])!;
    const lines = script.split('\n');
    const lastNonEmpty = lines.filter(l => l.trim()).pop();
    expect(lastNonEmpty).toBe('iptables -A OUTPUT -j DROP');
  });
});
