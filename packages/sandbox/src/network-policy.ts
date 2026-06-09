import type { SandboxNetworkTier } from '@agw/types';

const SAFE_DOMAIN = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

export function isValidDomain(domain: string): boolean {
  return SAFE_DOMAIN.test(domain) && domain.length <= 253;
}

/**
 * Resolve the Docker network mode for a given tier.
 *
 * - open: default bridge networking (unrestricted outbound)
 * - balanced: bridge networking (allowlist enforced via iptables inside container)
 * - locked: no networking at all
 */
export function resolveNetworkMode(tier: SandboxNetworkTier): string {
  switch (tier) {
    case 'open': return 'bridge';
    case 'balanced': return 'bridge';
    case 'locked': return 'none';
  }
}

/**
 * Whether the given tier requires iptables capabilities (NET_ADMIN + NET_RAW).
 */
export function needsIptables(tier: SandboxNetworkTier, allowlist: string[]): boolean {
  return tier === 'balanced' && allowlist.length > 0;
}

/**
 * Produce an iptables script that restricts outbound to allowed domains only.
 * Domains are validated against a strict regex to prevent shell injection.
 * Returns null for 'open'/'locked' tiers or empty allowlist.
 */
export function buildAllowlistScript(
  tier: SandboxNetworkTier,
  allowlist: string[],
): string | null {
  if (tier !== 'balanced' || allowlist.length === 0) return null;

  const safeDomains = allowlist.filter(d => isValidDomain(d));
  if (safeDomains.length === 0) return null;

  const lines: string[] = [
    '#!/bin/sh',
    'set -e',
    '',
    '# Allow loopback',
    'iptables -A OUTPUT -o lo -j ACCEPT',
    '',
    '# Allow established connections',
    'iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT',
    '',
    '# Allow DNS resolution',
    'iptables -A OUTPUT -p udp --dport 53 -j ACCEPT',
    'iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT',
    '',
  ];

  for (const domain of safeDomains) {
    lines.push(`# Allow ${domain}`);
    lines.push(`for ip in $(getent hosts ${domain} 2>/dev/null | awk '{print $1}'); do`);
    lines.push(`  iptables -A OUTPUT -d "$ip" -j ACCEPT`);
    lines.push('done');
    lines.push('');
  }

  lines.push('# Drop everything else');
  lines.push('iptables -A OUTPUT -j DROP');

  return lines.join('\n');
}
