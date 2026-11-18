// BE-007: a replica that does not hold a state rebuilds it from the caller's storage, the settings
// come from the environment, and a configured token guards every call but the probes. The replicas
// here are separate service objects, each behind its own HTTP server on an ephemeral port; the
// container run is in container.test.ts.
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { canonicalText } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { configFromEnv } from '../src/config.ts';
import { type RunningServer, listen } from '../src/http.ts';
import { AuthorityService, type OpenRequest } from '../src/service.ts';
import { httpStateLoader } from '../src/storage.ts';
import { buildLog, envelopeOf, openRequest } from './log.ts';

/** The caller's storage: serves `GET /states/{stateId}` from a map and counts the reads. */
async function storage(states: Map<string, OpenRequest>, override?: () => number | undefined) {
  const reads: string[] = [];
  const server: Server = createServer((req, res) => {
    const id = /^\/states\/([0-9a-f]{64})$/.exec(req.url ?? '')?.[1];
    reads.push(id ?? req.url ?? '');
    const forced = override?.();
    if (forced !== undefined) {
      res.writeHead(forced).end();
      return;
    }
    const found = id ? states.get(id) : undefined;
    if (!found) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(found));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    reads,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});
const track = <T extends { close(): Promise<void> }>(x: T): T => {
  open.push(() => x.close());
  return x;
};

async function replica(
  storageUrl: string,
  token?: string,
): Promise<{
  service: AuthorityService;
  http: RunningServer;
}> {
  const service = new AuthorityService({ loader: httpStateLoader({ baseUrl: storageUrl }) });
  const http = track(await listen({ service, ...(token ? { token } : {}) }));
  return { service, http };
}

describe('two replicas (BE-007 criterion 3)', () => {
  it('rebuilds a state it does not hold from storage instead of failing', async () => {
    const built = await buildLog(['a', 'b', 'c']);
    const req = await openRequest(built, 3);
    const store = track(await storage(new Map([[req.stateId, req]])));
    const a = await replica(store.url);
    const b = await replica(store.url);

    // Only replica A is told about the document.
    const opened = await fetch(`${a.http.url}/v1/authority/documents/${built.doc}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    expect(opened.status).toBe(201);
    expect(b.service.holds(req.stateId)).toBe(false);

    const expected = canonicalText(envelopeOf(built.docs[3]!));
    const fromA = await fetch(`${a.http.url}/v1/authority/states/${req.stateId}/content`);
    const fromB = await fetch(`${b.http.url}/v1/authority/states/${req.stateId}/content`);
    expect(fromA.status).toBe(200);
    expect(fromB.status).toBe(200);
    expect(await fromA.text()).toBe(expected);
    expect(await fromB.text()).toBe(expected);
    expect(store.reads).toEqual([req.stateId]); // A was told, B read storage once
    expect(b.service.holds(req.stateId)).toBe(true);

    await fetch(`${b.http.url}/v1/authority/states/${req.stateId}/content?seq=2`);
    expect(store.reads.length).toBe(1); // held now: no second read
  });

  it('also rebuilds for evaluateRules, and after a restart or an eviction', async () => {
    const built = await buildLog(['a', 'b']);
    const req = await openRequest(built, 2);
    const store = track(await storage(new Map([[req.stateId, req]])));
    const { service, http } = await replica(store.url);
    const rules = await fetch(`${http.url}/v1/authority/states/${req.stateId}/evaluate-rules`, {
      method: 'POST',
      body: '{}',
    });
    expect(rules.status).toBe(200);
    expect(store.reads.length).toBe(1);
    service.clear(); // a restart
    const again = await fetch(`${http.url}/v1/authority/states/${req.stateId}/content`);
    expect(await again.text()).toBe(canonicalText(envelopeOf(built.docs[2]!)));
    expect(store.reads.length).toBe(2);
  });

  it('says unknown_state when storage has no such state, and storage_unavailable when it fails', async () => {
    const states = new Map<string, OpenRequest>();
    const control: { fail?: number } = {};
    const store = track(await storage(states, () => control.fail));
    const { http } = await replica(store.url);
    const id = 'a'.repeat(64);
    const missing = await fetch(`${http.url}/v1/authority/states/${id}/content`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'unknown_state' });
    control.fail = 500;
    const down = await fetch(`${http.url}/v1/authority/states/${id}/content`);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ code: 'storage_unavailable' });
    // Storage that cannot be reached at all.
    const dead = await replica('http://127.0.0.1:1');
    const gone = await fetch(`${dead.http.url}/v1/authority/states/${id}/content`);
    expect(gone.status).toBe(503);
  });

  it('checks what storage returns as it checks an open call', async () => {
    const built = await buildLog(['a', 'b']);
    const req = await openRequest(built, 2);
    const other = await buildLog(['x', 'y']);
    const otherReq = await openRequest(other, 2);
    const tampered = structuredClone(req);
    tampered.commits[1]!.payload.retired = ['rGone'];
    const states = new Map<string, OpenRequest>([
      [req.stateId, tampered],
      [otherReq.stateId, { ...req }], // a state under another state's name
    ]);
    const store = track(await storage(states));
    const { http } = await replica(store.url);
    const bad = await fetch(`${http.url}/v1/authority/states/${req.stateId}/content`);
    expect(bad.status).toBe(409);
    expect(await bad.json()).toMatchObject({ code: 'chain_broken' });
    const wrong = await fetch(`${http.url}/v1/authority/states/${otherReq.stateId}/content`);
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ code: 'state_mismatch' });
  });
});

describe('the bearer token', () => {
  it('guards every call but the probes when it is set', async () => {
    const built = await buildLog(['a']);
    const req = await openRequest(built, 1);
    const { http } = await replica('http://127.0.0.1:1', 's3cret');
    const url = `${http.url}/v1/authority/documents/${built.doc}/open`;
    const send = (authorization?: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(req),
      });
    expect((await send()).status).toBe(401);
    expect((await send('Bearer nope')).status).toBe(401);
    expect((await send('Basic s3cret')).status).toBe(401);
    expect((await send('Bearer s3cret')).status).toBe(201);
    expect((await fetch(`${http.url}/v1/authority/ready`)).status).toBe(200);
    expect((await fetch(`${http.url}/v1/authority/health`)).status).toBe(200);
    expect((await fetch(`${http.url}/v1/authority/capabilities`)).status).toBe(401);
  });
});

describe('configuration from the environment', () => {
  it('has safe defaults: loopback, no migrations, no token', () => {
    expect(configFromEnv({})).toEqual({
      host: '127.0.0.1',
      port: 8090,
      capacity: 64,
      allowMigrations: false,
    });
  });

  it('reads every setting', () => {
    expect(
      configFromEnv({
        DOCEDIT_AUTHORITY_HOST: '0.0.0.0',
        DOCEDIT_AUTHORITY_PORT: '0',
        DOCEDIT_AUTHORITY_CAPACITY: '8',
        DOCEDIT_AUTHORITY_ALLOW_MIGRATIONS: 'true',
        DOCEDIT_AUTHORITY_TOKEN: 't',
        DOCEDIT_AUTHORITY_STORAGE_URL: 'http://storage.internal:8080',
        DOCEDIT_AUTHORITY_STORAGE_TOKEN: 's',
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 0,
      capacity: 8,
      allowMigrations: true,
      token: 't',
      storageUrl: 'http://storage.internal:8080',
      storageToken: 's',
    });
  });

  it('refuses a setting that makes no sense', () => {
    for (const env of [
      { DOCEDIT_AUTHORITY_PORT: 'x' },
      { DOCEDIT_AUTHORITY_PORT: '70000' },
      { DOCEDIT_AUTHORITY_CAPACITY: '0' },
      { DOCEDIT_AUTHORITY_ALLOW_MIGRATIONS: 'yes' },
      { DOCEDIT_AUTHORITY_STORAGE_URL: 'ftp://x' },
    ])
      expect(() => configFromEnv(env), JSON.stringify(env)).toThrow();
  });
});
