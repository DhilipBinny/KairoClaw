import { describe, it, expect } from 'vitest';
import { resolveNetworkMode, buildAllowlistScript, needsIptables, isValidDomain } from '../network-policy.js';

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

describe('needsIptables', () => {
  it('returns true for balanced with non-empty allowlist', () => {
    expect(needsIptables('balanced', ['example.com'])).toBe(true);
  });

  it('returns false for open', () => {
    expect(needsIptables('open', ['example.com'])).toBe(false);
  });

  it('returns false for locked', () => {
    expect(needsIptables('locked', ['example.com'])).toBe(false);
  });

  it('returns false for balanced with empty allowlist', () => {
    expect(needsIptables('balanced', [])).toBe(false);
  });
});

describe('isValidDomain', () => {
  it('accepts valid domains', () => {
    expect(isValidDomain('example.com')).toBe(true);
    expect(isValidDomain('api.openai.com')).toBe(true);
    expect(isValidDomain('registry.npmjs.org')).toBe(true);
    expect(isValidDomain('deb.debian.org')).toBe(true);
  });

  it('rejects shell injection attempts', () => {
    expect(isValidDomain('; rm -rf / #')).toBe(false);
    expect(isValidDomain('$(curl evil.com)')).toBe(false);
    expect(isValidDomain('`whoami`')).toBe(false);
    expect(isValidDomain('a; b')).toBe(false);
    expect(isValidDomain('a | b')).toBe(false);
  });

  it('rejects empty or whitespace', () => {
    expect(isValidDomain('')).toBe(false);
    expect(isValidDomain(' ')).toBe(false);
  });

  it('rejects domains starting/ending with special chars', () => {
    expect(isValidDomain('.example.com')).toBe(false);
    expect(isValidDomain('example.com.')).toBe(false);
    expect(isValidDomain('-example.com')).toBe(false);
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

  it('filters out invalid domains (shell injection protection)', () => {
    const script = buildAllowlistScript('balanced', [
      'valid.com',
      '; rm -rf /',
      '$(curl evil.com)',
      'also-valid.org',
    ]);
    expect(script).not.toBeNull();
    expect(script).toContain('valid.com');
    expect(script).toContain('also-valid.org');
    expect(script).not.toContain('rm -rf');
    expect(script).not.toContain('curl evil');
  });

  it('returns null when all domains are invalid', () => {
    expect(buildAllowlistScript('balanced', ['; bad', '$(evil)'])).toBeNull();
  });
});
