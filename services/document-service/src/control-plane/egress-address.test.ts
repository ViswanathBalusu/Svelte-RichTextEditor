// Address rules for webhook targets (PRO-071). `egress-address.ts` is the one classifier; the egress
// proxy (`webhook-egress.ts`, BE-056) refuses through it. The properties below run on the proxy's
// path (`refusedAddressReason` and `EgressProxy.deliver`), not only on the classifier.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AddressClass,
  classifyAddress,
  classifyHost,
  classifyIPv4,
  isPublicAddress,
  parseIPv4,
  parseIPv6,
} from './egress-address.ts';
import {
  EgressProxy,
  refusedAddressReason,
  type ConnectInput,
  type ConnectResult,
  type Connector,
  type Resolver,
} from './webhook-egress.ts';

// An independent list of the IPv4 ranges that are not public, written as CIDR blocks. The
// classifier must agree with it: an address is public exactly when no block contains it.
const NOT_PUBLIC_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function toInt(octets: readonly number[]): number {
  return octets.reduce((acc, o) => acc * 256 + o, 0);
}

function insideBlock(octets: readonly number[], base: string, bits: number): boolean {
  const start = toInt(base.split('.').map(Number));
  const size = 2 ** (32 - bits);
  const value = toInt(octets);
  return value >= start && value < start + size;
}

const octet = fc.integer({ min: 0, max: 255 });
const ipv4 = fc.tuple(octet, octet, octet, octet);
const ipv6Group = fc.integer({ min: 0, max: 0xffff });
const ipv6Groups = fc.array(ipv6Group, { minLength: 8, maxLength: 8 });

function hexText(groups: readonly number[]): string {
  return groups.map((g) => g.toString(16)).join(':');
}

describe('IPv4 classification (PRO-071)', () => {
  it.each<[string, AddressClass | 'invalid']>([
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.10', 'private'],
    ['169.254.10.10', 'link-local'],
    ['169.254.169.254', 'metadata'],
    ['100.64.0.1', 'private'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['192.0.2.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['256.1.1.1', 'invalid'],
    ['01.2.3.4', 'invalid'],
    ['1.2.3', 'invalid'],
    ['1.2.3.4.5', 'invalid'],
    ['1.2.3.-4', 'invalid'],
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it('parses only dotted decimal without leading zeros', () => {
    expect(parseIPv4('0.0.0.0')).toEqual([0, 0, 0, 0]);
    expect(parseIPv4('00.0.0.0')).toBeNull();
    expect(parseIPv4(' 1.2.3.4')).toBeNull();
  });

  it('agrees with an independent list of non-public blocks (property)', () => {
    fc.assert(
      fc.property(ipv4, (octets) => {
        const denied = NOT_PUBLIC_V4.some(([base, bits]) => insideBlock(octets, base, bits));
        expect(classifyIPv4(octets) === 'public').toBe(!denied);
      }),
      { numRuns: 3000 },
    );
  });

  it('classifies every address in the loopback, private and link-local ranges (property)', () => {
    const host = fc.tuple(octet, octet, octet);
    fc.assert(
      fc.property(host, ([b, c, d]) => {
        expect(classifyIPv4([127, b, c, d])).toBe('loopback');
        expect(classifyIPv4([10, b, c, d])).toBe('private');
        expect(classifyIPv4([192, 168, c, d])).toBe('private');
        expect(['link-local', 'metadata']).toContain(classifyIPv4([169, 254, c, d]));
        expect(classifyIPv4([172, 16 + (b % 16), c, d])).toBe('private');
        expect(isPublicAddress([127, b, c, d].join('.'))).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('IPv6 classification (PRO-071)', () => {
  it.each<[string, AddressClass | 'invalid']>([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['fec0::1', 'private'],
    ['fc00::1', 'private'],
    ['fd00:ec2::254', 'metadata'],
    ['fd00:ec2::255', 'private'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'reserved'],
    ['2001::1', 'reserved'],
    ['2002:c000:204::1', 'reserved'],
    ['100::1', 'reserved'],
    ['64:ff9b::1.2.3.4', 'reserved'],
    ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['64:ff9b::10.0.0.1', 'private'],
    ['2606:4700:4700::1111', 'public'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:8.8.8.8', 'public'],
    ['::127.0.0.1', 'reserved'],
    ['fe80::1%eth0', 'invalid'],
    ['::1::2', 'invalid'],
    [':::', 'invalid'],
    ['1:2:3:4:5:6:7:8::', 'invalid'],
    ['1:2:3:4:5:6:7:8:9', 'invalid'],
    ['1:2:3:4:5:6:7::', 'reserved'],
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it('reads a full eight-group address back from its hex text (property)', () => {
    fc.assert(
      fc.property(ipv6Groups, (groups) => {
        expect(parseIPv6(hexText(groups))).toEqual(groups);
      }),
      { numRuns: 1000 },
    );
  });

  it('classifies an IPv4-mapped address as its embedded IPv4 address (property)', () => {
    fc.assert(
      fc.property(ipv4, (octets) => {
        const text = `::ffff:${octets.join('.')}`;
        expect(classifyAddress(text)).toBe(classifyIPv4(octets));
      }),
      { numRuns: 1000 },
    );
  });
});

describe('host classification (PRO-071)', () => {
  it.each<[string, ReturnType<typeof classifyHost>]>([
    ['localhost', 'loopback'],
    ['LOCALHOST.', 'loopback'],
    ['hooks.localhost', 'loopback'],
    ['[::1]', 'loopback'],
    ['[fe80::1]', 'link-local'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'metadata'],
    ['93.184.216.34', 'public'],
    ['hooks.example.com', 'name'],
    ['', 'invalid'],
    ['fe80::1', 'link-local'],
  ])('%s is %s', (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });
});

// The egress proxy's refusal path. A connector that is never meant to be called records each call,
// so "no request leaves" is the empty call list.
function recordingConnector(): Connector & { calls: ConnectInput[] } {
  const calls: ConnectInput[] = [];
  return {
    calls,
    send(input: ConnectInput): Promise<ConnectResult> {
      calls.push(input);
      return Promise.resolve({ remoteAddress: input.address, status: 204, location: undefined });
    },
  };
}

/** A resolver that answers each name from a list, one answer per call, keeping the last one. */
function sequenceResolver(answers: Record<string, ReadonlyArray<readonly string[]>>): Resolver & {
  calls: string[];
} {
  const calls: string[] = [];
  const next: Record<string, number> = {};
  return {
    calls,
    resolve(host: string): Promise<readonly string[]> {
      calls.push(host);
      const list = answers[host];
      if (list === undefined) return Promise.reject(new Error('no such host'));
      const i = next[host] ?? 0;
      next[host] = i + 1;
      return Promise.resolve(list[Math.min(i, list.length - 1)] ?? []);
    },
  };
}

function v4Text(octets: readonly number[]): string {
  return octets.join('.');
}

describe('the egress proxy refuses through the one classifier (PRO-071, BE-056)', () => {
  it('refuses every IPv4 address the independent block list names, and passes the rest (property)', () => {
    fc.assert(
      fc.property(ipv4, (octets) => {
        const denied = NOT_PUBLIC_V4.some(([base, bits]) => insideBlock(octets, base, bits));
        expect(refusedAddressReason(v4Text(octets)) === null).toBe(!denied);
      }),
      { numRuns: 3000 },
    );
  });

  it('refuses the IPv6 ranges that embed or stand for other addresses (6to4, Teredo, NAT64, documentation, discard)', () => {
    expect(refusedAddressReason('2002:c000:204::1')).toBe('reserved');
    expect(refusedAddressReason('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe('reserved');
    expect(refusedAddressReason('2001:db8::1')).toBe('reserved');
    expect(refusedAddressReason('100::1')).toBe('reserved');
    expect(refusedAddressReason('64:ff9b::8.8.8.8')).toBe('reserved');
    expect(refusedAddressReason('64:ff9b::7f00:1')).toBe('loopback');
    expect(refusedAddressReason('100.64.0.1')).toBe('private');
    expect(refusedAddressReason('fe80::1%eth0')).toBe('not_an_address');
    expect(refusedAddressReason('2606:4700:4700::1111')).toBeNull();
  });

  it('refuses every address in fe80::/10, fc00::/7, ff00::/8 and 2002::/16 (property)', () => {
    fc.assert(
      fc.property(ipv6Groups, (groups) => {
        const first = groups[0] ?? 0;
        const text = hexText(groups);
        if ((first & 0xffc0) === 0xfe80) expect(refusedAddressReason(text)).toBe('link_local');
        if ((first & 0xfe00) === 0xfc00)
          expect(['private', 'metadata']).toContain(refusedAddressReason(text));
        if ((first & 0xff00) === 0xff00) expect(refusedAddressReason(text)).toBe('multicast');
        if (first === 0x2002) expect(refusedAddressReason(text)).toBe('reserved');
        // Only global unicast (2000::/3) can pass at all.
        if ((first & 0xe000) !== 0x2000) expect(refusedAddressReason(text)).not.toBeNull();
      }),
      { numRuns: 3000 },
    );
  });

  it('sends no request when a name resolves to a refused address, for any refused IPv4 block (property)', async () => {
    const refused = fc
      .tuple(fc.constantFrom(...NOT_PUBLIC_V4), fc.integer({ min: 0, max: 0xffffffff }))
      .map(([[base, bits], r]) => {
        const start = toInt(base.split('.').map(Number));
        const value = start + (r % 2 ** (32 - bits));
        return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
      });
    await fc.assert(
      fc.asyncProperty(refused, async (address) => {
        const connector = recordingConnector();
        const proxy = new EgressProxy({
          resolver: sequenceResolver({ 'hooks.example.test': [[address]] }),
          connector,
          maxRedirects: 0,
        });
        const got = await proxy.deliver({
          url: 'https://hooks.example.test/in',
          headers: {},
          body: '{}',
        });
        expect(got.ok).toBe(false);
        expect(connector.calls).toHaveLength(0);
      }),
      { numRuns: 300 },
    );
  });

  it('refuses a name that resolves to a 6to4 or Teredo address, with no connection', async () => {
    const connector = recordingConnector();
    const proxy = new EgressProxy({
      resolver: sequenceResolver({
        'six.example.test': [['2002:7f00:1::1']],
        'teredo.example.test': [['2001:0:4136:e378:8000:63bf:3fff:fdd2']],
      }),
      connector,
      maxRedirects: 0,
    });
    expect(
      await proxy.deliver({ url: 'https://six.example.test/', headers: {}, body: '' }),
    ).toEqual({ ok: false, reason: 'reserved' });
    expect(
      await proxy.deliver({ url: 'https://teredo.example.test/', headers: {}, body: '' }),
    ).toEqual({ ok: false, reason: 'reserved' });
    expect(connector.calls).toHaveLength(0);
  });

  it('refuses localhost and names under .localhost as loopback without asking the resolver', async () => {
    const resolver = sequenceResolver({ localhost: [['93.184.216.34']] });
    const connector = recordingConnector();
    const proxy = new EgressProxy({ resolver, connector, maxRedirects: 0 });
    expect(await proxy.deliver({ url: 'http://localhost:8080/', headers: {}, body: '' })).toEqual({
      ok: false,
      reason: 'loopback',
    });
    expect(await proxy.deliver({ url: 'http://hooks.localhost/', headers: {}, body: '' })).toEqual({
      ok: false,
      reason: 'loopback',
    });
    expect(await proxy.deliver({ url: 'http://[::1]/', headers: {}, body: '' })).toEqual({
      ok: false,
      reason: 'loopback',
    });
    expect(resolver.calls).toEqual([]);
    expect(connector.calls).toHaveLength(0);
  });

  it('checks the address at delivery time: a name that was public once and is private now is refused', async () => {
    const resolver = sequenceResolver({ 'moving.example.test': [['93.184.216.34'], ['10.0.0.7']] });
    const connector = recordingConnector();
    const proxy = new EgressProxy({ resolver, connector, maxRedirects: 0 });
    const first = await proxy.deliver({
      url: 'https://moving.example.test/in',
      headers: {},
      body: '{}',
    });
    expect(first).toEqual({ ok: true, status: 204, hops: 0 });
    const second = await proxy.deliver({
      url: 'https://moving.example.test/in',
      headers: {},
      body: '{}',
    });
    expect(second).toEqual({ ok: false, reason: 'private' });
    expect(resolver.calls).toEqual(['moving.example.test', 'moving.example.test']);
    expect(connector.calls).toHaveLength(1);
  });
});
