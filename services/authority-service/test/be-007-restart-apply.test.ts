// BE-007 criterion 2, in process: a service that restarted holds nothing; `open` with the same inputs
// rebuilds the document, and the next `applyCommit` gives the answer it gave before the restart,
// byte for byte, for an accepted commit and for a rejected one. The restart here is a new service
// object behind a new HTTP server; the same flow against a killed container is in container.test.ts.
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningServer, listen } from '../src/http.ts';
import { AuthorityService, type OpenRequest } from '../src/service.ts';
import { httpStateLoader } from '../src/storage.ts';
import { applyRequest, buildLog, openRequest, posInside } from './log.ts';

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
});

async function start(options: ConstructorParameters<typeof AuthorityService>[0] = {}) {
  const service = new AuthorityService(options);
  const http: RunningServer = await listen({ service });
  running.push(http);
  return { service, url: http.url };
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface Accepted {
  stateId: string;
  seq: number;
  commits: OpenRequest['commits'];
}

describe('applyCommit after a restart (BE-007 criterion 2)', () => {
  it('gives the same answer once open was called again with the same inputs', async () => {
    const built = await buildLog(['a', 'b', 'c']);
    const req = await openRequest(built, 3);
    const at = posInside(built.docs[3]!, 'pTwo000000000001');
    const accepted = applyRequest(1, 3, at, 'Again ');
    const refused = applyRequest(2, 3, at, 'No ', 'viewer');
    const next = applyRequest(3, 4, at, 'More ');

    const before = await start();
    const open = (url: string, body: unknown = req) =>
      post(`${url}/v1/authority/documents/${built.doc}/open`, body);
    const apply = (url: string, state: string, body: unknown) =>
      post(`${url}/v1/authority/states/${state}/commits`, body);
    expect((await open(before.url)).status).toBe(201);
    const first = await apply(before.url, req.stateId, accepted);
    expect(first.status).toBe(200);
    const firstText = await first.text();
    const made = JSON.parse(firstText) as Accepted;
    expect(made.seq).toBe(4);
    expect(made.commits.at(-1)!.hash).toBe(made.stateId);
    const refusedText = await (await apply(before.url, req.stateId, refused)).text();
    expect(JSON.parse(refusedText)).toMatchObject({ rejected: { code: 'permission_denied' } });
    const nextText = await (await apply(before.url, made.stateId, next)).text();
    expect((JSON.parse(nextText) as Accepted).seq).toBe(5);

    // The restart: another service, which has never seen the document.
    const after = await start();
    const lost = await apply(after.url, req.stateId, accepted);
    expect(lost.status).toBe(404);
    expect(((await lost.json()) as { code: string }).code).toBe('unknown_state');

    // `open` again with the same inputs, then the same call: the same answer as before.
    expect((await open(after.url)).status).toBe(201);
    expect(await (await apply(after.url, req.stateId, accepted)).text()).toBe(firstText);
    expect(await (await apply(after.url, req.stateId, refused)).text()).toBe(refusedText);
    // The state the commit made is rebuilt from what its answer carried: the caller stored those
    // commits, and opens the log with them at the end.
    const longer = { ...req, commits: [...req.commits, ...made.commits], stateId: made.stateId };
    expect((await open(after.url, longer)).status).toBe(201);
    expect(await (await apply(after.url, made.stateId, next)).text()).toBe(nextText);
  });

  it('gives the same answer without a second open when the service can read the caller’s storage', async () => {
    const built = await buildLog(['a', 'b']);
    const req = await openRequest(built, 2);
    const at = posInside(built.docs[2]!, 'pOne000000000001');
    const body = applyRequest(1, 2, at, 'Hi ');

    const states = new Map<string, OpenRequest>([[req.stateId, req as OpenRequest]]);
    const storage: Server = createServer((q, r) => {
      const found = states.get(/^\/states\/([0-9a-f]{64})$/.exec(q.url ?? '')?.[1] ?? '');
      if (!found) r.writeHead(404).end();
      else r.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(found));
    });
    await new Promise<void>((done) => storage.listen(0, '127.0.0.1', done));
    running.push({
      close: () =>
        new Promise<void>((done) => {
          storage.close(() => done());
          storage.closeAllConnections();
        }),
    });
    const storageUrl = `http://127.0.0.1:${(storage.address() as AddressInfo).port}`;

    const loader = () => ({ loader: httpStateLoader({ baseUrl: storageUrl }) });
    const before = await start(loader());
    const apply = (url: string) => post(`${url}/v1/authority/states/${req.stateId}/commits`, body);
    const firstText = await (await apply(before.url)).text();
    expect((JSON.parse(firstText) as Accepted).seq).toBe(3);

    const after = await start(loader());
    expect(after.service.holds(req.stateId)).toBe(false);
    expect(await (await apply(after.url)).text()).toBe(firstText);
  });
});
