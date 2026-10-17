import { describe, it, expect, vi } from 'vitest';
import { validateMcpUrl, validateResolvedMcpIP } from '../security.js';

describe('validateMcpUrl — SSRF protection for MCP HTTP transports', () => {
  it('accepts a valid public HTTPS URL', () => {
    const url = validateMcpUrl('https://mcp.example.com/v1');
    expect(url.hostname).toBe('mcp.example.com');
  });

  it('accepts a valid public HTTP URL', () => {
    const url = validateMcpUrl('http://mcp.example.com/mcp');
    expect(url.protocol).toBe('http:');
  });

  it('rejects non-HTTP schemes', () => {
    expect(() => validateMcpUrl('ftp://evil.com')).toThrow('Blocked URL scheme');
    expect(() => validateMcpUrl('file:///etc/passwd')).toThrow('Blocked URL scheme');
    expect(() => validateMcpUrl('javascript:alert(1)')).toThrow(/Invalid URL|Blocked/);
  });

  it('rejects invalid URLs', () => {
    expect(() => validateMcpUrl('not a url')).toThrow('Invalid URL');
    expect(() => validateMcpUrl('')).toThrow('Invalid URL');
  });

  // Loopback addresses
  it('blocks localhost', () => {
    expect(() => validateMcpUrl('http://localhost:3000')).toThrow(/localhost/);
  });

  it('blocks 127.0.0.1', () => {
    expect(() => validateMcpUrl('http://127.0.0.1:8080')).toThrow(/localhost/);
  });

  it('blocks ::1', () => {
    expect(() => validateMcpUrl('http://[::1]:9090')).toThrow(/localhost/);
  });

  it('blocks 0.0.0.0', () => {
    expect(() => validateMcpUrl('http://0.0.0.0')).toThrow(/localhost/);
  });

  // Private IP ranges
  it('blocks 10.x.x.x (Class A private)', () => {
    expect(() => validateMcpUrl('http://10.0.2.20:5432')).toThrow(/private/);
  });

  it('blocks 172.16-31.x.x (Class B private)', () => {
    expect(() => validateMcpUrl('http://172.16.0.1')).toThrow(/private/);
    expect(() => validateMcpUrl('http://172.31.255.255')).toThrow(/private/);
  });

  it('blocks 192.168.x.x (Class C private)', () => {
    expect(() => validateMcpUrl('http://192.168.1.1')).toThrow(/private/);
  });

  it('blocks 169.254.x.x (link-local)', () => {
    expect(() => validateMcpUrl('http://169.254.169.254')).toThrow(/private/);
  });

  // Cloud metadata
  it('blocks cloud metadata endpoints', () => {
    expect(() => validateMcpUrl('http://metadata.google.internal')).toThrow(/metadata/);
  });

  // IPv6 private
  it('blocks fe80: link-local IPv6', () => {
    expect(() => validateMcpUrl('http://[fe80::1]')).toThrow(/private/);
  });

  it('blocks fc/fd unique-local IPv6', () => {
    expect(() => validateMcpUrl('http://[fc00::1]')).toThrow(/private/);
    expect(() => validateMcpUrl('http://[fd12::1]')).toThrow(/private/);
  });

  // allowPrivate override
  it('allows localhost when explicitly in allowPrivate', () => {
    const url = validateMcpUrl('http://localhost:3000', ['localhost:3000']);
    expect(url.hostname).toBe('localhost');
  });

  it('allows a private IP when in allowPrivate', () => {
    const url = validateMcpUrl('http://10.0.2.20:8080', ['10.0.2.20:8080']);
    expect(url.hostname).toBe('10.0.2.20');
  });

  it('does not allow localhost without port when only port-specific entry exists', () => {
    expect(() => validateMcpUrl('http://localhost:9999', ['localhost:3000'])).toThrow(/localhost/);
  });

  it('allows bare hostname match in allowPrivate', () => {
    const url = validateMcpUrl('http://localhost', ['localhost']);
    expect(url.hostname).toBe('localhost');
  });

  it('allows IPv6 in allowPrivate without brackets', () => {
    const url = validateMcpUrl('http://[::1]:9090', ['::1:9090']);
    expect(url.port).toBe('9090');
  });

  // Cloud metadata
  it('blocks AWS metadata IP (169.254.169.254)', () => {
    expect(() => validateMcpUrl('http://169.254.169.254/latest/meta-data')).toThrow(/private/);
  });

  // CGNAT
  it('blocks CGNAT range (100.64.0.0/10)', () => {
    expect(() => validateMcpUrl('http://100.64.0.1')).toThrow(/private/);
    expect(() => validateMcpUrl('http://100.127.255.255')).toThrow(/private/);
  });

  it('allows non-CGNAT 100.x addresses', () => {
    const url = validateMcpUrl('http://100.63.255.255');
    expect(url.hostname).toBe('100.63.255.255');
  });
});

describe('validateResolvedMcpIP — DNS rebinding protection', () => {
  it('skips validation for IP literals', async () => {
    await expect(validateResolvedMcpIP('8.8.8.8')).resolves.toBeUndefined();
  });

  it('blocks hostnames that resolve to private IPs', async () => {
    const dns = await import('node:dns');
    const lookupSpy = vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce(
      [{ address: '10.0.0.1', family: 4 }] as any,
    );
    await expect(validateResolvedMcpIP('evil.example.com')).rejects.toThrow(/private IP 10\.0\.0\.1/);
    lookupSpy.mockRestore();
  });

  it('blocks if any resolved address is private', async () => {
    const dns = await import('node:dns');
    const lookupSpy = vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce(
      [{ address: '1.2.3.4', family: 4 }, { address: '192.168.1.1', family: 4 }] as any,
    );
    await expect(validateResolvedMcpIP('dual.example.com')).rejects.toThrow(/private IP 192\.168\.1\.1/);
    lookupSpy.mockRestore();
  });

  it('passes when all resolved addresses are public', async () => {
    const dns = await import('node:dns');
    const lookupSpy = vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce(
      [{ address: '1.2.3.4', family: 4 }, { address: '5.6.7.8', family: 4 }] as any,
    );
    await expect(validateResolvedMcpIP('safe.example.com')).resolves.toBeUndefined();
    lookupSpy.mockRestore();
  });
});
