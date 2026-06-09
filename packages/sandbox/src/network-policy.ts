import type { SandboxNetworkTier } from '@agw/types';

/**
 * Resolve the Docker network mode for a given tier.
 *
 * - open: default bridge networking (unrestricted outbound)
 * - balanced: bridge networking (allowlist enforced via separate mechanism)
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
 * For "balanced" tier, produce an iptables script that restricts
 * outbound to only the allowed domains.
 *
 * This runs inside the container as an init command. Since DNS resolves
 * at connection time and container networking goes through Docker's NAT,
 * we use a DNS-based approach: resolve each domain to IPs, then allow
 * only those IPs via iptables.
 *
 * Returns null for 'open' and 'locked' tiers (no script needed).
 */
export function buildAllowlistScript(
  tier: SandboxNetworkTier,
  allowlist: string[],
): string | null {
  if (tier !== 'balanced' || allowlist.length === 0) return null;

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

  for (const domain of allowlist) {
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
