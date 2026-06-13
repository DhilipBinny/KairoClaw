/**
 * SSRF protection for HTTP plugins.
 *
 * HTTP plugins are admin-configured, and reaching private/internal networks is
 * an INTENDED use (e.g. an internal API on 10.x or 192.168.x). So this guard
 * does NOT block RFC 1918 private ranges. What it blocks is the set of targets
 * that are never a legitimate plugin endpoint and are the actual SSRF prizes:
 * loopback, the link-local / cloud-metadata range (169.254.0.0/16, incl.
 * 169.254.169.254), the unspecified/"this host" ranges, and the IPv6
 * equivalents — including IPv4-mapped forms like ::ffff:127.0.0.1.
 *
 * Crucially, validating the hostname string is not enough: DNS rebinding lets a
 * name pass a string check and then resolve to an internal IP at connect time.
 * `ssrfSafeLookup` closes that hole by resolving the name, validating EVERY
 * resolved address, and handing the validated address straight to the socket —
 * so the IP that was checked is exactly the IP that is connected to (no
 * time-of-check/time-of-use gap). Wire it into an undici dispatcher and pass
 * that dispatcher to every plugin fetch.
 */
import dns from 'node:dns';
import net from 'node:net';
import { Agent, type Dispatcher } from 'undici';

/** Returns a reason string if the numeric IP is a blocked SSRF target, else null. */
export function blockedIpReason(ip: string): string | null {
  if (net.isIPv4(ip)) return blockedIpv4Reason(ip);
  if (net.isIPv6(ip)) return blockedIpv6Reason(canonicalizeIpv6(ip));
  return null; // not a literal IP — hostnames are handled by the resolving lookup
}

/**
 * Collapse an IPv6 literal to its canonical compressed form so the classifier
 * does not depend on the caller having normalized it. Without this, a fully
 * expanded form like `0:0:0:0:0:ffff:127.0.0.1` would slip past the
 * compressed-form regexes below. We reuse the platform URL parser, which yields
 * the same canonical form Node/undici connect with.
 */
function canonicalizeIpv6(ip: string): string {
  try {
    return new URL(`http://[${ip}]`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return ip.toLowerCase();
  }
}

function blockedIpv4Reason(ip: string): string | null {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return 'malformed IPv4 address';
  }
  if (o[0] === 127) return 'loopback (127.0.0.0/8)';
  if (o[0] === 0) return 'unspecified/this-host (0.0.0.0/8)';
  if (o[0] === 169 && o[1] === 254) return 'link-local / cloud metadata (169.254.0.0/16)';
  return null;
}

function blockedIpv6Reason(ip: string): string | null {
  if (ip === '::1') return 'loopback (::1)';
  if (ip === '::' || ip === '::0') return 'unspecified (::)';

  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible (::127.0.0.1) — unwrap the
  // embedded IPv4 and apply the IPv4 rules so e.g. ::ffff:169.254.169.254 is caught.
  const mapped = ip.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    const reason = blockedIpv4Reason(mapped[1]);
    return reason ? `IPv4-mapped ${reason}` : null;
  }
  // Hex form of an IPv4-mapped (::ffff:7f00:1) or IPv4-compatible (::7f00:1)
  // address — the high 96 bits are zero either way, so unwrap the embedded IPv4.
  const hexMapped = ip.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    const reason = blockedIpv4Reason(v4);
    return reason ? `IPv4-mapped ${reason}` : null;
  }

  // fe80::/10 link-local (fe80–febf in the first hextet).
  const first = ip.split(':')[0];
  if (first.length >= 3 && first.startsWith('fe')) {
    const val = parseInt(first, 16);
    if (!Number.isNaN(val) && val >= 0xfe80 && val <= 0xfebf) return 'link-local (fe80::/10)';
  }
  return null;
}

/**
 * dns.lookup-compatible function that rejects the request if the hostname is a
 * literal blocked IP or resolves to any blocked address, and otherwise returns
 * the resolved (validated) address(es) for the socket to connect to. Pinning the
 * connection to these exact addresses is what defeats DNS rebinding.
 */
export function ssrfSafeLookup(
  hostname: string,
  options: dns.LookupAllOptions | dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  // Literal IP host — validate directly, no DNS needed.
  const literal = blockedIpReason(hostname);
  if (literal) {
    callback(ssrfError(hostname, literal), '');
    return;
  }

  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) { callback(err, ''); return; }
    if (!addresses || addresses.length === 0) {
      callback(ssrfError(hostname, 'no addresses resolved'), '');
      return;
    }
    for (const a of addresses) {
      const reason = blockedIpReason(a.address);
      if (reason) { callback(ssrfError(hostname, `${reason} via ${a.address}`), ''); return; }
    }
    if ((options as dns.LookupAllOptions).all) {
      callback(null, addresses);
    } else {
      const fam = (options as dns.LookupOptions).family;
      const chosen = (fam ? addresses.find(a => a.family === fam) : undefined) || addresses[0];
      callback(null, chosen.address, chosen.family);
    }
  });
}

function ssrfError(hostname: string, reason: string): NodeJS.ErrnoException {
  const e = new Error(`Blocked SSRF target "${hostname}": ${reason}`) as NodeJS.ErrnoException;
  e.code = 'EAI_BLOCKED';
  return e;
}

let dispatcher: Dispatcher | undefined;

/** Shared undici dispatcher that pins connections to SSRF-validated addresses. */
export function ssrfSafeDispatcher(): Dispatcher {
  if (!dispatcher) {
    dispatcher = new Agent({ connect: { lookup: ssrfSafeLookup } });
  }
  return dispatcher;
}
