// BE-056: webhook deliveries leave only through the egress proxy, which refuses private addresses,
// checks the address it connects to, and checks every redirect as a new request. The network
// policy that makes the proxy the only route out (criterion 4) is infrastructure and is not tested
// here. The real connector is tested against a loopback server; the policy is tested with fakes.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EgressProxy,
  nodeConnector,
  refusedAddressReason,
  sameAddress,
  type ConnectInput,
  type ConnectResult,
  type Connector,
  type Resolver,
} from './webhook-egress.ts';

const PUBLIC = '93.184.216.34';

function fixedResolver(map: Record<string, readonly string[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve(host: string): Promise<readonly string[]> {
      calls.push(host);
      const got = map[host];
      return got === undefined ? Promise.reject(new Error('no such host')) : Promise.resolve(got);
    },
  };
}

/** A connector that answers from a script, one answer per call, and records each call. */
function scriptedConnector(
  answers: Array<(input: ConnectInput) => ConnectResult>,
): Connector & { calls: ConnectInput[] } {
  const calls: ConnectInput[] = [];
  let next = 0;
  return {
    calls,
    send(input: ConnectInput): Promise<ConnectResult> {
      calls.push(input);
      const answer = answers[next] ?? answers[answers.length - 1];
      next += 1;
      if (answer === undefined) return Promise.reject(new Error('no answer scripted'));
      return Promise.resolve(answer(input));
    },
  };
}

/** A success that reports the address the policy checked (the honest connector). */
const ok200 = (input: ConnectInput): ConnectResult => ({
  remoteAddress: input.address,
  status: 200,
  location: undefined,
});

describe('BE-056 the policy refuses private, loopback, link-local and metadata addresses', () => {
  it('refuses the named categories for IPv4 and returns the reason', () => {
    expect(refusedAddressReason('127.0.0.1')).toBe('loopback');
    expect(refusedAddressReason('10.0.0.5')).toBe('private');
    expect(refusedAddressReason('172.16.0.1')).toBe('private');
    expect(refusedAddressReason('172.31.255.255')).toBe('private');
    expect(refusedAddressReason('172.32.0.1')).toBeNull();
    expect(refusedAddressReason('192.168.1.1')).toBe('private');
    expect(refusedAddressReason('169.254.10.10')).toBe('link_local');
    expect(refusedAddressReason('169.254.169.254')).toBe('metadata');
    expect(refusedAddressReason('0.0.0.0')).toBe('unspecified');
    expect(refusedAddressReason(PUBLIC)).toBeNull();
  });

  it('refuses IPv6 and the IPv4 addresses carried in IPv6 forms', () => {
    expect(refusedAddressReason('::1')).toBe('loopback');
    expect(refusedAddressReason('::')).toBe('unspecified');
    expect(refusedAddressReason('fe80::1')).toBe('link_local');
    expect(refusedAddressReason('fd00:ec2::254')).toBe('metadata');
    expect(refusedAddressReason('fd12:3456::1')).toBe('private');
    expect(refusedAddressReason('::ffff:127.0.0.1')).toBe('loopback');
    expect(refusedAddressReason('::ffff:a9fe:a9fe')).toBe('metadata');
    expect(refusedAddressReason('64:ff9b::a9fe:a9fe')).toBe('metadata');
    expect(refusedAddressReason('2606:2800:220:1:248:1893:25c8:1946')).toBeNull();
    expect(refusedAddressReason('[::1]')).toBe('loopback');
    expect(refusedAddressReason('not an address')).toBe('not_an_address');
  });

  it('refuses every address of 10/8 and 127/8, for any octets (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (b, c, d) => {
          expect(refusedAddressReason(`10.${b}.${c}.${d}`)).toBe('private');
          expect(refusedAddressReason(`127.${b}.${c}.${d}`)).toBe('loopback');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('compares two spellings of one IPv6 address as the same address', () => {
    expect(sameAddress('2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(true);
    expect(sameAddress(PUBLIC, '93.184.216.35')).toBe(false);
  });
});

describe('BE-056 the proxy records the refusal and connects only to the checked address', () => {
  it('refuses a host that resolves to a private address and records the reason, with no connection', async () => {
    const resolver = fixedResolver({ 'hooks.example.test': ['10.1.2.3'] });
    const connector = scriptedConnector([ok200]);
    const proxy = new EgressProxy({ resolver, connector, maxRedirects: 3 });
    const got = await proxy.deliver({
      url: 'https://hooks.example.test/in',
      headers: {},
      body: '{}',
    });
    expect(got).toEqual({ ok: false, reason: 'private' });
    expect(connector.calls).toHaveLength(0);
  });

  it('refuses the whole host when any one of its addresses is refused', async () => {
    const resolver = fixedResolver({ 'mixed.example.test': [PUBLIC, '169.254.169.254'] });
    const connector = scriptedConnector([ok200]);
    const proxy = new EgressProxy({ resolver, connector, maxRedirects: 3 });
    const got = await proxy.deliver({
      url: 'https://mixed.example.test/in',
      headers: {},
      body: '{}',
    });
    expect(got).toEqual({ ok: false, reason: 'metadata' });
    expect(connector.calls).toHaveLength(0);
  });

  it('connects to the address it checked, resolving the name once', async () => {
    const resolver = fixedResolver({ 'hooks.example.test': [PUBLIC] });
    const connector = scriptedConnector([ok200]);
    const proxy = new EgressProxy({ resolver, connector, maxRedirects: 3 });
    const got = await proxy.deliver({
      url: 'https://hooks.example.test/in',
      headers: { a: 'b' },
      body: 'x',
    });
    expect(got).toEqual({ ok: true, status: 200, hops: 0 });
    expect(resolver.calls).toEqual(['hooks.example.test']);
    expect(connector.calls[0]?.address).toBe(PUBLIC);
  });

  it('refuses when the socket reports an address other than the one checked (a name that moved)', async () => {
    const resolver = fixedResolver({ 'moved.example.test': [PUBLIC] });
    const connector = scriptedConnector([
      () => ({ remoteAddress: '10.0.0.9', status: 200, location: undefined }),
    ]);
    const proxy = new EgressProxy({ resolver, connector, maxRedirects: 3 });
    const got = await proxy.deliver({
      url: 'https://moved.example.test/in',
      headers: {},
      body: '',
    });
    expect(got).toEqual({ ok: false, reason: 'address_changed' });
  });

  it('refuses when the socket reports no address at all', async () => {
    const connector = scriptedConnector([
      () => ({ remoteAddress: undefined, status: 200, location: undefined }),
    ]);
    const proxy = new EgressProxy({ resolver: fixedResolver({}), connector, maxRedirects: 3 });
    const got = await proxy.deliver({ url: `https://${PUBLIC}/in`, headers: {}, body: '' });
    expect(got).toEqual({ ok: false, reason: 'address_unverified' });
  });

  it('refuses an unresolvable name, an IP literal in a private range, a non-http scheme and credentials', async () => {
    const proxy = new EgressProxy({
      resolver: fixedResolver({}),
      connector: scriptedConnector([ok200]),
      maxRedirects: 3,
    });
    expect(
      await proxy.deliver({ url: 'https://nowhere.example.test/', headers: {}, body: '' }),
    ).toEqual({ ok: false, reason: 'unresolved' });
    expect(
      await proxy.deliver({ url: 'https://169.254.169.254/latest', headers: {}, body: '' }),
    ).toEqual({ ok: false, reason: 'metadata' });
    expect(await proxy.deliver({ url: 'ftp://93.184.216.34/x', headers: {}, body: '' })).toEqual({
      ok: false,
      reason: 'bad_scheme',
    });
    expect(
      await proxy.deliver({ url: 'https://user:pw@93.184.216.34/x', headers: {}, body: '' }),
    ).toEqual({ ok: false, reason: 'credentials_in_url' });
    expect(await proxy.deliver({ url: 'not a url', headers: {}, body: '' })).toEqual({
      ok: false,
      reason: 'malformed_url',
    });
  });
});

describe('BE-056 a redirect to a private address is refused on the second request', () => {
  it('refuses the metadata address a public target redirects to, and sends no second request', async () => {
    const resolver = fixedResolver({ 'redirect.example.test': [PUBLIC] });
    const connector = scriptedConnector([
      () => ({
        remoteAddress: PUBLIC,
        status: 302,
        location: 'http://169.254.169.254/latest/meta-data',
      }),
      ok200,
    ]);
    const proxy = new EgressProxy({ resolver, connector, maxRedirects: 3 });
    const got = await proxy.deliver({
      url: 'https://redirect.example.test/in',
      headers: {},
      body: '{}',
    });
    expect(got).toEqual({ ok: false, reason: 'metadata' });
    expect(connector.calls).toHaveLength(1);
  });

  it('follows a redirect to a public address and reports the hop count', async () => {
    const resolver = fixedResolver({
      'a.example.test': [PUBLIC],
      'b.example.test': ['93.184.216.35'],
    });
    const connector = scriptedConnector([
      () => ({ remoteAddress: PUBLIC, status: 307, location: 'https://b.example.test/next' }),
      () => ({ remoteAddress: '93.184.216.35', status: 204, location: undefined }),
    ]);
    const proxy = new EgressProxy({ resolver, connector, maxRedirects: 3 });
    const got = await proxy.deliver({ url: 'https://a.example.test/in', headers: {}, body: '{}' });
    expect(got).toEqual({ ok: true, status: 204, hops: 1 });
    expect(connector.calls.map((c) => c.address)).toEqual([PUBLIC, '93.184.216.35']);
  });

  it('stops after the configured number of redirects', async () => {
    const resolver = fixedResolver({ 'loop.example.test': [PUBLIC] });
    const connector = scriptedConnector([
      () => ({ remoteAddress: PUBLIC, status: 302, location: 'https://loop.example.test/again' }),
    ]);
    const proxy = new EgressProxy({ resolver, connector, maxRedirects: 2 });
    const got = await proxy.deliver({ url: 'https://loop.example.test/in', headers: {}, body: '' });
    expect(got).toEqual({ ok: false, reason: 'too_many_redirects' });
    expect(connector.calls).toHaveLength(3);
  });

  it('refuses a redirect whose target is the loopback address with a bad scheme, before connecting', async () => {
    const resolver = fixedResolver({ 'r.example.test': [PUBLIC] });
    const connector = scriptedConnector([
      () => ({ remoteAddress: PUBLIC, status: 301, location: 'file:///etc/passwd' }),
    ]);
    const proxy = new EgressProxy({ resolver, connector, maxRedirects: 3 });
    const got = await proxy.deliver({ url: 'https://r.example.test/', headers: {}, body: '' });
    expect(got).toEqual({ ok: false, reason: 'bad_scheme' });
    expect(connector.calls).toHaveLength(1);
  });
});

describe('BE-056 the Node.js connector reports the address it reached', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('posts the body to the checked address and reports the remote address', async () => {
    const received: string[] = [];
    server = createServer((req, res) => {
      let text = '';
      req.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
      });
      req.on('end', () => {
        received.push(`${req.method} ${req.url} ${String(req.headers['webhook-id'])} ${text}`);
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const connector = nodeConnector(2_000);
    const answer = await connector.send({
      address: '127.0.0.1',
      url: new URL(`http://localhost:${port}/hook`),
      headers: { 'webhook-id': 'msg_test' },
      body: '{"a":1}',
    });
    expect(answer.status).toBe(204);
    expect(answer.remoteAddress).toBe('127.0.0.1');
    expect(received).toEqual(['POST /hook msg_test {"a":1}']);
  });

  it('refuses a non-positive timeout at construction', () => {
    expect(() => nodeConnector(0)).toThrow(RangeError);
  });
});
