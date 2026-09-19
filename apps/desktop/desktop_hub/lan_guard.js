/**
 * Relay target validation for the desktop hub.
 *
 * The hub forwards a chunk to a destination on the sender's behalf, so an unvalidated target
 * would turn it into an SSRF pivot. The rules below are intentionally narrow:
 *
 *  1. RFC1918 addresses are private by definition.
 *  2. A destination on the same subnet as one of this machine's own interfaces is an on-link
 *     LAN peer. This is what makes non-RFC1918 home/office networks (and the many routers
 *     that hand out unusual ranges) work without any configuration, while still refusing
 *     anything that would have to be routed off-link.
 *  3. An explicit operator allowlist covers the remaining cases, such as reaching a peer on
 *     another subnet or across a VPN overlay.
 *
 * Loopback and link-local addresses are always refused: they are never a legitimate transfer
 * destination, and link-local in particular is where cloud metadata services live
 * (169.254.169.254). Placing this check before the same-subnet rule matters, because a host
 * with an APIPA interface would otherwise derive 169.254.0.0/16 and open exactly that hole.
 *
 * Kept dependency-free (node:os only) and exported for direct unit testing.
 */
const os = require('os');

/**
 * Parse a dotted-quad IPv4 address into an unsigned 32-bit integer, or null if malformed.
 *
 * Only the canonical spelling is accepted. A leading zero ("010.1.2.3") is refused rather than
 * normalised, because this function reads it as decimal 10 while the resolver underneath an
 * outbound connection reads it as octal 8 - so a permissive parse here would let the guard
 * approve one address and the socket connect to another.
 */
function ipv4ToUint(ip) {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  value = value >>> 0;
  if (uintToIpv4(value) !== trimmed) return null;
  return value;
}

/** Render an unsigned 32-bit integer back to dotted-quad form. */
function uintToIpv4(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join('.');
}

const RFC1918 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/;

// Ranges that must never be relay destinations, checked before the same-subnet rule.
const FORBIDDEN_RANGES = [
  { network: ipv4ToUint('127.0.0.0'), mask: ipv4ToUint('255.0.0.0'), label: 'loopback' },
  { network: ipv4ToUint('169.254.0.0'), mask: ipv4ToUint('255.255.0.0'), label: 'link-local' },
  { network: ipv4ToUint('0.0.0.0'), mask: ipv4ToUint('255.0.0.0'), label: 'this-network' }
];

function inRange(value, range) {
  return ((value & range.mask) >>> 0) === range.network;
}

/** Optional operator-supplied destinations: SAFEDROP_RELAY_TARGETS=10.8.0.4,10.8.0.5 */
const relayTargetAllowlist = new Set(
  (process.env.SAFEDROP_RELAY_TARGETS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
);

let subnetCache = { at: 0, subnets: [] };

/**
 * Networks this machine is directly attached to, derived from interface address + netmask.
 * Cached briefly because the relay path evaluates this per chunk while interfaces rarely change.
 */
function localSubnets() {
  const now = Date.now();
  if (now - subnetCache.at < 10000) return subnetCache.subnets;

  const subnets = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (!iface.address || !iface.netmask) continue;

      const address = ipv4ToUint(iface.address);
      const mask = ipv4ToUint(iface.netmask);
      if (address === null || mask === null) continue;

      const network = (address & mask) >>> 0;
      // Skip ranges that are never valid peers, so they cannot leak in via this rule.
      if (FORBIDDEN_RANGES.some((range) => inRange(network, range))) continue;

      subnets.push({ network, mask, address, interface: name });
    }
  }

  subnetCache = { at: now, subnets };
  return subnets;
}

/** True when the address sits inside one of this machine's own directly-attached networks. */
function isOnLocalSubnet(ip) {
  const target = ipv4ToUint(ip);
  if (target === null) return false;
  return localSubnets().some((subnet) => ((target & subnet.mask) >>> 0) === subnet.network);
}

/** Decide whether the hub may relay a chunk to this address. */
function isAllowedRelayTarget(ip) {
  const target = ipv4ToUint(ip);
  if (target === null) return false;

  // Never relay to loopback, link-local or the unspecified range.
  if (FORBIDDEN_RANGES.some((range) => inRange(target, range))) return false;

  if (RFC1918.test(String(ip).trim())) return true;
  if (relayTargetAllowlist.has(String(ip).trim())) return true;
  return isOnLocalSubnet(ip);
}

/** Human-readable summary of the currently derived local networks, for logging. */
function describeLocalSubnets() {
  return localSubnets().map((subnet) => {
    const hostBits = (~subnet.mask) >>> 0;
    const prefix = hostBits ? 32 - Math.round(Math.log2(hostBits + 1)) : 32;
    return `${uintToIpv4(subnet.network)}/${prefix}`;
  });
}

module.exports = {
  ipv4ToUint,
  uintToIpv4,
  localSubnets,
  isOnLocalSubnet,
  isAllowedRelayTarget,
  describeLocalSubnets,
  relayTargetAllowlist,
  FORBIDDEN_RANGES
};
