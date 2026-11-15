// PRO-008 criterion 2 (05 §2): the client treats discovery's `rest` as the complete base URL. It
// builds every request by appending the resource path to it, and a notification's `resource` names
// the same path, relative to the same base.
//
// The server here publishes a `rest` on another host and under another path than the endpoint, and
// a gateway answers only under that base. A client that guessed `{endpoint}/v1`, or that resolved
// paths against the base as a browser resolves links (dropping the base's own path), would get 404.
// Universal: Node.js and browsers.
import { describe, expect, it } from 'vitest';
import type { Notification } from '@docedit/protocol';
import { createDepBackend, type DepBackend } from './index.ts';
import { LEGAL_GRANT, USERS, contractDocument } from '../test/support/fixtures.ts';
import {
  MemoryNetwork,
  type HttpRequest,
  type HttpResponse,
  type MemoryServer,
  type ServerSocket,
} from '../test/support/memory-network.ts';
import { MockDepServer } from '../test/support/mock-server.ts';
import { FileServer, STORAGE } from '../test/support/file-server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(pred: () => boolean, what: string, ms = 3000): Promise<void> {
  for (let waited = 0; !pred(); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** The base the server publishes: another host, and a path of its own before the version. */
const BASE = 'https://api.elsewhere.test/gateway/tenant-7/v1';

/**
 * Answers discovery at the endpoint, storage at its own origin, and the REST API only under
 * `base`; everything else is 404. Requests under the base are handed to the inner server at the
 * place it serves them (`{origin}/v1`).
 */
class Gateway implements MemoryServer {
  /** The requests that were outside the base, the discovery document and the storage. */
  readonly strays: string[] = [];
  private readonly inner: MemoryServer;
  private readonly origin: string;
  private readonly base: string;

  constructor(inner: MemoryServer, origin: string, base: string) {
    this.inner = inner;
    this.origin = origin;
    this.base = base;
  }

  accept(socket: ServerSocket): string | null {
    return this.inner.accept(socket);
  }

  async http(req: HttpRequest): Promise<HttpResponse> {
    if (req.url === `${this.origin}/.well-known/dep` || req.url.startsWith(`${STORAGE}/`))
      return this.inner.http(req);
    if (req.url.startsWith(`${this.base}/`))
      return this.inner.http({
        ...req,
        url: `${this.origin}/v1${req.url.slice(this.base.length)}`,
      });
    this.strays.push(req.url);
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'no such place' };
  }
}

function setup(rest: string = BASE) {
  const dep = new MockDepServer({
    discovery: (d) => ({ ...d, rest }),
    welcome: (d) => ({
      ...d,
      features: [
        ...new Set([...((d['features'] as string[] | undefined) ?? []), 'assets', 'exports']),
      ],
    }),
  });
  const files = new FileServer(dep);
  const gateway = new Gateway(files, dep.origin, BASE);
  const net = new MemoryNetwork(gateway);
  const docId = dep.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const make = (): DepBackend =>
    createDepBackend({
      endpoint: dep.endpoint,
      getToken: async () => dep.mintToken(USERS.editor, { [docId]: 'owner' }),
      features: ['presence', 'regions', 'suggest-enforced', 'assets', 'exports'],
      platform: { random: () => 0, ...net.platform() },
    });
  /** The REST requests: all but discovery and the pre-signed storage addresses. */
  const restRequests = (): HttpRequest[] =>
    net.requests.filter(
      (r) => r.url !== `${dep.origin}/.well-known/dep` && !r.url.startsWith(`${STORAGE}/`),
    );
  return { dep, files, gateway, net, docId, make, restRequests };
}

async function live(s: ReturnType<typeof setup>, b: DepBackend): Promise<Notification[]> {
  await b.connect();
  const c = await b.sync.loadContent(s.docId);
  const ch = await b.sync.open(s.docId, { resume: { seq: c.seq, incarnation: c.incarnation } });
  const events: Notification[] = [];
  ch.onEvent((e) => events.push(e));
  return events;
}

const source = (text: string, type: string) => {
  const bytes = new TextEncoder().encode(text);
  return {
    size: bytes.byteLength,
    type,
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
  };
};

describe('`rest` is the complete base URL (PRO-008 criterion 2)', () => {
  it('sends every REST request to `rest` plus the resource path, on the host and under the path `rest` names', async () => {
    const s = setup();
    const b = s.make();
    await live(s, b);
    await b.permissions.regions!(s.docId);
    const g = await b.permissions.grants!(s.docId);
    await b.permissions.updateGrants!(s.docId, { grants: g.value.grants }, { ifMatch: g.etag });
    const job = await b.exports!.request(s.docId, { target: 'pdf' });
    await b.exports!.get(job.id);
    await b.exports!.cancel(job.id);
    await b.fonts!.manifest();

    const doc = encodeURIComponent(s.docId);
    const urls = s.restRequests().map((r) => `${r.method} ${r.url.split('?')[0]}`);
    expect(new Set(urls)).toEqual(
      new Set([
        `GET ${BASE}/documents/${doc}/content`,
        `GET ${BASE}/documents/${doc}/regions`,
        `GET ${BASE}/documents/${doc}/grants`,
        `PATCH ${BASE}/documents/${doc}/grants`,
        `POST ${BASE}/documents/${doc}/exports`,
        `GET ${BASE}/exports/${job.id}`,
        `DELETE ${BASE}/exports/${job.id}`,
        `GET ${BASE}/fonts`,
      ]),
    );
    // Nothing went to the endpoint's own `/v1`, or anywhere else the gateway does not serve.
    expect(s.gateway.strays).toEqual([]);
    await b.close();
  });

  it('accepts a `rest` that ends in a slash and builds the same addresses', async () => {
    const s = setup(`${BASE}/`);
    const b = s.make();
    await live(s, b);
    await b.permissions.regions!(s.docId);
    expect(s.restRequests().map((r) => r.url.split('?')[0])).toEqual(
      expect.arrayContaining([`${BASE}/documents/${encodeURIComponent(s.docId)}/regions`]),
    );
    expect(s.restRequests().every((r) => r.url.startsWith(`${BASE}/`))).toBe(true);
    expect(s.gateway.strays).toEqual([]);
    await b.close();
  });

  it('reads the `resource` of a notification relative to `rest`: an asset', async () => {
    const s = setup();
    const b = s.make();
    const events = await live(s, b);
    // The upload resolves only when `asset.ready` names this asset, so the client matched the
    // notification's `resource` with the path it uses under `rest`.
    const up = await b.assets!.upload(s.docId, {
      filename: 'logo.png',
      source: source('pixels', 'image/png'),
    });
    await until(() => events.some((e) => e.type === 'asset.ready'), 'asset.ready');
    const ready = events.find((e) => e.type === 'asset.ready')!;
    expect(ready.resource).toBe(`/assets/${up.asset}`);
    const completed = s.restRequests().find((r) => r.url.endsWith('/complete'))!;
    expect(completed.url).toBe(`${BASE}${ready.resource}/complete`);
    expect(s.gateway.strays).toEqual([]);
    await b.close();
  });

  it('reads the `resource` of a notification relative to `rest`: an export job', async () => {
    const s = setup();
    const b = s.make();
    const events = await live(s, b);
    const job = await b.exports!.request(s.docId, { target: 'pdf' });
    s.files.jobs.get(job.id)!.state = 'completed';
    s.dep.sessions.at(-1)!.event('export.completed', `/exports/${job.id}`);
    await until(() => events.some((e) => e.type === 'export.completed'), 'export.completed');
    const note = events.find((e) => e.type === 'export.completed')!;
    // The job the notification names is fetched at `rest` plus its `resource`.
    const before = s.restRequests().length;
    const read = await b.exports!.get(job.id);
    expect(read.value.state).toBe('completed');
    const request = s.restRequests()[before]!;
    expect(`${request.method} ${request.url}`).toBe(`GET ${BASE}${note.resource}`);
    expect(s.gateway.strays).toEqual([]);
    await b.close();
  });
});
