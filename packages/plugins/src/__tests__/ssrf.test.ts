import { describe, it, expect } from 'vitest';
import { blockedIpReason, ssrfSafeLookup } from '../ssrf.js';
import { validatePluginUrl } from '../http.js';

describe('blockedIpReason — SSRF IP classifier (#146)', () => {
  it('blocks loopback / link-local / metadata / unspecified IPv4', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '169.254.169.254', '169.254.0.1', '0.0.0.0', '0.1.2.3']) {
      expect(blockedIpReason(ip)).toBeTruthy();
    }
  });

  it('ALLOWS RFC1918 private + public IPv4 (intended for admin plugins)', () => {
    for (const ip of ['10.0.0.5', '172.16.3.4', '192.168.1.10', '8.8.8.8', '1.1.1.1']) {
      expect(blockedIpReason(ip)).toBeNull();
    }
  });

  it('blocks IPv6 loopback / unspecified / link-local', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'FE80::abcd']) {
      expect(blockedIpReason(ip)).toBeTruthy();
    }
  });

  it('blocks IPv4-mapped IPv6 forms of blocked addresses', () => {
    for (const ip of ['::ffff:127.0.0.1', '::ffff:169.254.169.254', '::127.0.0.1', '::ffff:7f00:1']) {
      expect(blockedIpReason(ip)).toBeTruthy();
    }
  });

  it('blocks UNCOMPRESSED IPv4-mapped IPv6 literals (self-sufficient classifier)', () => {
    for (const ip of [
      '0:0:0:0:0:ffff:127.0.0.1',
      '0000:0000:0000:0000:0000:ffff:7f00:0001',
      '0:0:0:0:0:ffff:169.254.169.254',
    ]) {
      expect(blockedIpReason(ip)).toBeTruthy();
    }
  });

  it('ALLOWS public / ULA IPv6', () => {
    for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(blockedIpReason(ip)).toBeNull();
    }
  });

  it('returns null for non-IP hostnames (handled by the resolving lookup)', () => {
    expect(blockedIpReason('example.com')).toBeNull();
  });
});

describe('validatePluginUrl (#146 hardening)', () => {
  it('rejects bad schemes and loopback/metadata hosts', () => {
    expect(() => validatePluginUrl('ftp://example.com')).toThrow();
    expect(() => validatePluginUrl('http://localhost/x')).toThrow();
    expect(() => validatePluginUrl('http://127.0.0.1/x')).toThrow();
    expect(() => validatePluginUrl('http://[::1]/x')).toThrow();
    expect(() => validatePluginUrl('http://[::ffff:127.0.0.1]/x')).toThrow();
    expect(() => validatePluginUrl('http://169.254.169.254/latest/meta-data/')).toThrow();
    expect(() => validatePluginUrl('http://metadata.google.internal/x')).toThrow();
  });

  it('allows public and private admin endpoints', () => {
    expect(() => validatePluginUrl('https://api.example.com/v1')).not.toThrow();
    expect(() => validatePluginUrl('http://10.0.2.20:5006/openapi.json')).not.toThrow();
    expect(() => validatePluginUrl('http://192.168.1.50/x')).not.toThrow();
  });
});

describe('ssrfSafeLookup — connection pinning (#146)', () => {
  const lookup = (host: string) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) => {
      ssrfSafeLookup(host, { all: false }, (err, address, family) => resolve({ err, address, family }));
    });

  it('rejects a literal blocked IP without DNS', async () => {
    const r = await lookup('127.0.0.1');
    expect(r.err).toBeTruthy();
    expect(r.err?.code).toBe('EAI_BLOCKED');
  });

  it('rejects a hostname that resolves to loopback (rebinding defence)', async () => {
    // localhost resolves to 127.0.0.1 / ::1 — must be blocked at resolve time.
    const r = await lookup('localhost');
    expect(r.err).toBeTruthy();
    expect(r.err?.code).toBe('EAI_BLOCKED');
  });

  it('returns the address for a literal public IP', async () => {
    const r = await lookup('8.8.8.8');
    expect(r.err).toBeNull();
    expect(r.address).toBe('8.8.8.8');
    expect(r.family).toBe(4);
  });

  it('returns all validated addresses when options.all is set', async () => {
    const r = await new Promise<{ err: unknown; address: unknown }>((resolve) => {
      ssrfSafeLookup('8.8.8.8', { all: true }, (err, address) => resolve({ err, address }));
    });
    expect(r.err).toBeNull();
    expect(Array.isArray(r.address)).toBe(true);
  });
});
