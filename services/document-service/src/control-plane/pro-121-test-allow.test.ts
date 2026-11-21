// PRO-121: the test-mode allow-list of the egress proxy (ADR 0316 proposal 2). The conformance kit's
// receiver is on loopback, which the policy refuses (10 §3.2). A server in test mode may name exact
// IP literals it reaches anyway; the list is refused outside test mode, and everything it does not
// name stays refused. The real Node.js connector and a loopback server that counts requests.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfig, configFromEnv } from '../config.ts';
import { EgressProxy, nodeConnector, systemResolver } from './webhook-egress.ts';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

async function countingTarget(): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    res.writeHead(204);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

const proxy = (allow?: readonly string[]) =>
  new EgressProxy({
    resolver: systemResolver,
    connector: nodeConnector(2000),
    maxRedirects: 0,
    ...(allow ? { allow } : {}),
  });

const send = (p: EgressProxy, url: string) =>
  p.deliver({ url, headers: { 'content-type': 'application/json' }, body: '{}' });

describe('the egress allow-list of test mode (PRO-121)', () => {
  it('reaches a loopback literal that is named, and only that one', async () => {
    const target = await countingTarget();
    const allowed = await send(proxy(['127.0.0.1']), `http://127.0.0.1:${target.port}/hook`);
    expect(allowed).toMatchObject({ ok: true, status: 204 });
    expect(target.hits()).toBe(1);
    // Another loopback literal, the name `localhost` and a private address stay refused.
    for (const url of [
      `http://127.0.0.2:${target.port}/hook`,
      `http://localhost:${target.port}/hook`,
      'http://10.0.0.1/hook',
      'http://169.254.169.254/latest/meta-data',
    ])
      expect(await send(proxy(['127.0.0.1']), url), url).toMatchObject({ ok: false });
    expect(target.hits()).toBe(1);
  });

  it('refuses the same target without a list', async () => {
    const target = await countingTarget();
    expect(await send(proxy(), `http://127.0.0.1:${target.port}/hook`)).toEqual({
      ok: false,
      reason: 'loopback',
    });
    expect(target.hits()).toBe(0);
  });

  it('is read from DOCEDIT_TEST_WEBHOOK_ALLOW and refused outside test mode', () => {
    const env = {
      DOCEDIT_WEBHOOKS: 'true',
      DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '1000',
      DOCEDIT_WEBHOOK_REJECTED_MAX: '5',
      DOCEDIT_WEBHOOK_TIMEOUT_MS: '1000',
      DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
      DOCEDIT_TEST_WEBHOOK_ALLOW: '127.0.0.1, ::1',
    };
    expect(() => configFromEnv(env)).toThrow(/test mode only/);
    const on = configFromEnv({
      ...env,
      DOCEDIT_TEST_MODE: 'true',
      DOCEDIT_ENVIRONMENT: 'test',
    });
    expect(on.webhooks?.testAllow).toEqual(['127.0.0.1', '::1']);
    expect(() => checkConfig(on)).not.toThrow();
    expect(configFromEnv({ ...env, DOCEDIT_TEST_WEBHOOK_ALLOW: '' }).webhooks?.testAllow).toBe(
      undefined,
    );
  });
});
