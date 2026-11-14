// Address rules for webhook targets (05 §7; 10 §3.2, §3.7; 06 §1; PRO-071).
//
// 10 §3.2 says the egress proxy refuses private and link-local addresses. This module is the one
// classifier for that decision: it classifies IP literals and a target's host name, and sends
// nothing. The egress proxy (`webhook-egress.ts`, BE-056) maps each class to its refusal reason
// through `refusedAddressReason`; there is no other address check in the service.
//
// The classifier fails closed. An address is `public` only when it lies in a range that is globally
// routable; every other range is refused. The refused ranges are a superset of the ones 10 §3.2
// names (loopback, private, link-local, the cloud metadata address, IPv6 link-local), so a range
// the spec does not list (for example CGNAT, documentation space, 6to4 or Teredo) is refused too.
//
// A host name is not decided here. Its address is known only when it is resolved, and PRO-071
// criterion 4 requires the check at delivery time, against the resolved address, not the name.

/** The class of an IP literal, or of a host that names a loopback address. */
export type AddressClass =
  | 'public'
  /** 0.0.0.0/8 and `::`. */
  | 'unspecified'
  | 'loopback'
  /** RFC 1918, shared address space (CGNAT, 100.64.0.0/10), unique local and site-local IPv6. */
  | 'private'
  | 'link-local'
  /** The cloud metadata address: 169.254.169.254 and fd00:ec2::254. */
  | 'metadata'
  | 'multicast'
  /** Documentation, benchmarking, 6to4, Teredo, NAT64, discard and other non-global ranges. */
  | 'reserved';

/** What a target's host name says before it is resolved. */
export type HostClass = AddressClass | 'name' | 'invalid';

/** Four octets, each 0 to 255. Leading zeros are refused: they read as octal in some parsers. */
export function parseIPv4(text: string): [number, number, number, number] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  const [a, b, c, d] = octets as [number, number, number, number];
  return [a, b, c, d];
}

/** The class of an IPv4 address written in four octets. */
export function classifyIPv4(octets: readonly [number, number, number, number]): AddressClass {
  const [a, b, c, d] = octets;
  if (a === 0) return 'unspecified'; // 0.0.0.0/8, this network
  if (a === 10) return 'private'; // 10.0.0.0/8
  if (a === 127) return 'loopback'; // 127.0.0.0/8
  if (a === 169 && b === 254) return c === 169 && d === 254 ? 'metadata' : 'link-local'; // 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
  if (a === 192 && b === 168) return 'private'; // 192.168.0.0/16
  // 100.64.0.0/10, shared address space (RFC 6598): carrier networks, not the internet.
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'reserved'; // IETF and TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // 198.18.0.0/15, benchmarking
  if (a === 198 && b === 51 && c === 100) return 'reserved'; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'reserved'; // TEST-NET-3
  if (a >= 224 && a <= 239) return 'multicast'; // 224.0.0.0/4
  if (a >= 240) return 'reserved'; // 240.0.0.0/4 and the broadcast address
  return 'public';
}

/**
 * Eight 16-bit groups of an IPv6 address, or null when the text is not one. A zone identifier
 * (`%eth0`) is refused: it is only meaningful on one host.
 */
export function parseIPv6(text: string): number[] | null {
  if (text.includes('%')) return null;
  let body = text;
  const lastColon = body.lastIndexOf(':');
  const tail = body.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    body = `${body.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  if (halves.length === 1) {
    const all = groups(body);
    return all && all.length === 8 ? all : null;
  }
  const left = groups(halves[0] ?? '');
  const right = groups(halves[1] ?? '');
  if (!left || !right) return null;
  const fill = 8 - left.length - right.length;
  // "::" stands for one or more groups; eight written groups with "::" are not an address.
  if (fill < 1) return null;
  return [...left, ...new Array<number>(fill).fill(0), ...right];
}

/** The class of the IPv4 address in the last 32 bits of an IPv6 address. */
function embeddedIPv4(g: readonly number[]): AddressClass {
  const at = (i: number): number => g[i] ?? 0;
  return classifyIPv4([at(6) >> 8, at(6) & 0xff, at(7) >> 8, at(7) & 0xff]);
}

/** The class of an IPv6 address given as eight groups. */
export function classifyIPv6(g: readonly number[]): AddressClass {
  const at = (i: number): number => g[i] ?? 0;
  const head5Zero = [0, 1, 2, 3, 4].every((i) => at(i) === 0);
  // ::ffff:a.b.c.d (IPv4-mapped): the class of the embedded IPv4 address.
  if (head5Zero && at(5) === 0xffff) return embeddedIPv4(g);
  if (g.every((x) => x === 0)) return 'unspecified'; // ::
  if (head5Zero && at(5) === 0 && at(6) === 0 && at(7) === 1) return 'loopback'; // ::1
  if (head5Zero && at(5) === 0) return 'reserved'; // ::a.b.c.d, IPv4-compatible (deprecated)
  if ((at(0) & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  // fd00:ec2::254, the cloud metadata address over IPv6, inside the unique-local range.
  if (
    at(0) === 0xfd00 &&
    at(1) === 0x0ec2 &&
    [2, 3, 4, 5, 6].every((i) => at(i) === 0) &&
    at(7) === 0x0254
  ) {
    return 'metadata';
  }
  if ((at(0) & 0xfe00) === 0xfc00) return 'private'; // fc00::/7, unique local
  if ((at(0) & 0xffc0) === 0xfec0) return 'private'; // fec0::/10, site-local (deprecated)
  if ((at(0) & 0xff00) === 0xff00) return 'multicast'; // ff00::/8
  // 64:ff9b::/96, NAT64: a refused embedded IPv4 address gives its own class; a public one is
  // still refused, because the translator, not this proxy, decides where the request goes.
  if (at(0) === 0x0064 && at(1) === 0xff9b) {
    const carried = embeddedIPv4(g);
    return carried === 'public' ? 'reserved' : carried;
  }
  if (at(0) === 0x2001 && at(1) === 0x0db8) return 'reserved'; // 2001:db8::/32, documentation
  if (at(0) === 0x2001 && at(1) === 0) return 'reserved'; // 2001::/32, Teredo (embeds an IPv4)
  if (at(0) === 0x2002) return 'reserved'; // 2002::/16, 6to4 (embeds an IPv4)
  if (at(0) === 0x0100 && at(1) === 0 && at(2) === 0 && at(3) === 0) return 'reserved'; // 100::/64
  if ((at(0) & 0xe000) === 0x2000) return 'public'; // 2000::/3, global unicast
  return 'reserved';
}

/** The class of an IP literal (IPv4 or IPv6, without brackets), or `invalid`. */
export function classifyAddress(address: string): AddressClass | 'invalid' {
  const v4 = parseIPv4(address);
  if (v4) return classifyIPv4(v4);
  const v6 = parseIPv6(address);
  if (v6) return classifyIPv6(v6);
  return 'invalid';
}

/** True only for a globally routable IP literal. */
export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === 'public';
}

/**
 * The class of a target's host, as a URL gives it (`hostname`: IPv6 literals keep their brackets).
 * `localhost` and names under `.localhost` are loopback by definition (RFC 6761). Any other name is
 * `name`: its address is decided when it is resolved, not here (PRO-071 criterion 4).
 */
export function classifyHost(hostname: string): HostClass {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (host === '') return 'invalid';
  const literal = classifyAddress(host);
  if (literal !== 'invalid') return literal;
  if (host.includes(':')) return 'invalid'; // a colon outside brackets is not a host name
  const lower = host.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) return 'loopback';
  return 'name';
}
