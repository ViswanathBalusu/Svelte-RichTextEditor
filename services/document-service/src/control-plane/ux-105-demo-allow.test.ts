// UX-105 criteria 2 and 3: the demo stack's exception in the egress proxy (ADR 0471, proposed).
// The reference host is on loopback, which the policy refuses (10 §3.2). A demo service names the
// host's exact `address:port`; every other port of that address, every other address, the name
// `localhost` and every redirect stay checked as before, and the setting is refused in production.
// The real Node.js connector and loopback servers that count requests.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfig, configFromEnv } from '../config.ts';
import { EgressProxy, nodeConnector, parseEndpoint, systemResolver } from './webhook-egress.ts';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

async function target(
  handler?: (url: string) => { status: number; location?: string },
): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    const answer = handler?.(req.url ?? '/') ?? { status: 204 };
    res.writeHead(answer.status, answer.location ? { location: answer.location } : {});
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

const proxy = (allowEndpoints?: readonly string[], maxRedirects = 0) =>
  new EgressProxy({
    resolver: systemResolver,
    connector: nodeConnector(2000),
    maxRedirects,
    ...(allowEndpoints ? { allowEndpoints } : {}),
  });

const send = (p: EgressProxy, url: string) =>
  p.deliver({ url, headers: { 'content-type': 'application/json' }, body: '{}' });

describe('the demo exception of the egress proxy (UX-105 criteria 2 and 3)', () => {
  it('reaches the named address and port, and no other port of the same address', async () => {
    const host = await target();
    const other = await target();
    const p = proxy([`127.0.0.1:${host.port}`]);
    expect(await send(p, `http://127.0.0.1:${host.port}/webhooks/dep`)).toMatchObject({
      ok: true,
      status: 204,
    });
    expect(host.hits()).toBe(1);
    // The service's own port, the database and the object store are other ports of 127.0.0.1.
    expect(await send(p, `http://127.0.0.1:${other.port}/`)).toEqual({
      ok: false,
      reason: 'loopback',
    });
    expect(other.hits()).toBe(0);
  });

  it('refuses every other loopback or private address, and the name localhost', async () => {
    const host = await target();
    const p = proxy([`127.0.0.1:${host.port}`]);
    for (const [url, reason] of [
      [`http://127.0.0.2:${host.port}/`, 'loopback'],
      [`http://localhost:${host.port}/`, 'loopback'],
      [`http://[::1]:${host.port}/`, 'loopback'],
      [`http://10.0.0.1:${host.port}/`, 'private'],
      ['http://169.254.169.254/latest/meta-data', 'metadata'],
    ] as const)
      expect(await send(p, url), url).toEqual({ ok: false, reason });
    expect(host.hits()).toBe(0);
  });

  it('checks a redirect again: to another port or address it is refused', async () => {
    const other = await target();
    const host = await target(() => ({
      status: 307,
      location: `http://127.0.0.1:${other.port}/elsewhere`,
    }));
    const p = proxy([`127.0.0.1:${host.port}`], 3);
    expect(await send(p, `http://127.0.0.1:${host.port}/`)).toEqual({
      ok: false,
      reason: 'loopback',
    });
    expect(host.hits()).toBe(1);
    expect(other.hits()).toBe(0);
  });

  it('refuses the same target when the exception is not configured (the reasons of PRO-071)', async () => {
    const host = await target();
    expect(await send(proxy(), `http://127.0.0.1:${host.port}/`)).toEqual({
      ok: false,
      reason: 'loopback',
    });
    expect(await send(proxy([]), `http://10.0.0.1:${host.port}/`)).toEqual({
      ok: false,
      reason: 'private',
    });
    expect(host.hits()).toBe(0);
  });

  it('takes IPv6 literals in brackets and refuses a text that is not an endpoint', () => {
    expect(parseEndpoint('127.0.0.1:56490')).toEqual({ address: '127.0.0.1', port: 56490 });
    expect(parseEndpoint('[::1]:56490')).toEqual({ address: '::1', port: 56490 });
    for (const bad of ['127.0.0.1', 'localhost:80', '127.0.0.1:0', '127.0.0.1:70000', '::1:80', ''])
      expect(parseEndpoint(bad), bad).toBeNull();
    expect(() => proxy(['127.0.0.1'])).toThrow(RangeError);
  });
});

describe('DOCEDIT_DEMO_WEBHOOK_ALLOW (UX-105 criterion 2)', () => {
  const env = {
    DOCEDIT_WEBHOOKS: 'true',
    DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '1000',
    DOCEDIT_WEBHOOK_REJECTED_MAX: '5',
    DOCEDIT_WEBHOOK_TIMEOUT_MS: '1000',
    DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
    DOCEDIT_DEMO_WEBHOOK_ALLOW: '127.0.0.1:56490',
  };

  it('is refused in production, which is the default, and by checkConfig', () => {
    expect(() => configFromEnv(env)).toThrow(/refused in production/);
    expect(() => configFromEnv({ ...env, DOCEDIT_ENVIRONMENT: 'production' })).toThrow(
      /refused in production/,
    );
  });

  it('is read in a development or test environment and does not turn on test mode', () => {
    for (const environment of ['development', 'test']) {
      const c = configFromEnv({ ...env, DOCEDIT_ENVIRONMENT: environment });
      expect(c.webhooks?.demoAllow).toEqual(['127.0.0.1:56490']);
      expect(c.testMode).toBe(false);
      expect(() => checkConfig(c)).not.toThrow();
    }
  });

  it('is refused when an entry is not an address with a port, and empty means none', () => {
    expect(() =>
      configFromEnv({
        ...env,
        DOCEDIT_ENVIRONMENT: 'development',
        DOCEDIT_DEMO_WEBHOOK_ALLOW: '127.0.0.1',
      }),
    ).toThrow(/address:port/);
    const none = configFromEnv({
      ...env,
      DOCEDIT_ENVIRONMENT: 'development',
      DOCEDIT_DEMO_WEBHOOK_ALLOW: '',
    });
    expect(none.webhooks?.demoAllow).toBeUndefined();
  });

  it('does not accept the test-mode list without test mode (PRO-121 is unchanged)', () => {
    expect(() =>
      configFromEnv({
        ...env,
        DOCEDIT_ENVIRONMENT: 'development',
        DOCEDIT_TEST_WEBHOOK_ALLOW: '127.0.0.1',
      }),
    ).toThrow(/test mode only/);
  });
});
