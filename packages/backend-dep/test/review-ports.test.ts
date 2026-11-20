// backend-dep's history, comments, leases and imports ports over REST (PRO-097; 05 §6.1, §6.2,
// §3.1): the routes each call uses, the If-Match and Idempotency-Key headers, the problem codes, and
// which ports a backend offers for which features. The REST calls are recorded by a fake fetch, so
// the wire is exact; the feature tests run a real backend against the mock DEP server.
import { describe, expect, it } from 'vitest';
import { isPortError, type Operations, type Query } from '@docedit/protocol';
import { createDepBackend } from '../src/index.ts';
import { RestClient } from '../src/rest.ts';
import { createReviewPorts, type ReviewPorts } from '../src/review.ts';
import type { Platform, ResponseLike } from '../src/platform.ts';
import { LEGAL_GRANT, USERS, contractDocument } from './support/fixtures.ts';
import { MemoryNetwork } from './support/memory-network.ts';
import { MockDepServer } from './support/mock-server.ts';

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Reply {
  status?: number;
  body?: unknown;
  etag?: string;
}

/** A REST client whose fetch records every request and answers with `reply`. */
function recordingRest(reply: (s: Sent) => Reply = () => ({ status: 200, body: {} })): {
  ports: ReviewPorts;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const fetch = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    const s: Sent = {
      method: init?.method ?? 'GET',
      url,
      headers: init?.headers ?? {},
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    };
    sent.push(s);
    const r = reply(s);
    const status = r.status ?? 200;
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    const res: ResponseLike = {
      status,
      headers: { get: (name: string) => (name === 'etag' ? (r.etag ?? null) : null) },
      text: async () => text,
    };
    return res;
  };
  const platform = { fetch } as unknown as Platform;
  const client = new RestClient('https://dep.test/api', platform, {
    token: async () => 'secret-token',
    renew: async () => 'renewed-token',
  });
  return { ports: createReviewPorts({ rest: async () => client }), sent };
}

const DOC = 'doc-1';
/* Valid response bodies for the shapes the client checks (05 §1 rule 3: unknown members pass). */
const UUID = '0190f3a2-7b4c-7d1e-8a2b-3c4d5e6f7a8b';
const VERSION = { seq: 3, kind: 'named', name: 'v1' };
const DIFF = { fromSeq: 1, toSeq: 2, changes: [] };
/* The thread and comment shapes of ADR 0417 (gap G71). */
const COMMENT = {
  id: UUID,
  author: 'user:u-1',
  createdAt: '2026-11-13T09:00:00.000Z',
  editedAt: null,
  etag: '"c:0"',
  body: [{ type: 'text', text: 'hi' }],
};
const THREAD = {
  id: UUID,
  state: 'open',
  assignee: null,
  createdBy: 'user:u-1',
  createdAt: '2026-11-13T09:00:00.000Z',
  etag: '"t:open:"',
  comments: [COMMENT],
};
const LEASE = { id: 'l-1', holder: 'u-1', expiresAt: '2026-11-13T10:00:00.000Z' };
const IMPORT_JOB = { id: UUID };
/* Request bodies in these tests are arbitrary: the wire, not the body type, is under test. */
const cast = (x: unknown): never => x as never;
const query = <K extends keyof Operations>(x: unknown) => x as Query<K>;

describe('history port over REST (PRO-097 criterion 1)', () => {
  it('lists history, versions and activity with GET and no conditional headers', async () => {
    const { ports, sent } = recordingRest((s) =>
      s.url.endsWith('/history')
        ? { body: { items: [], nextCursor: null } }
        : s.url.endsWith('/versions')
          ? { body: { items: [], nextCursor: null } }
          : { body: {} },
    );
    await ports.history.history(DOC);
    await ports.history.versions(DOC);
    await ports.history.activity(DOC);
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      ['GET', `https://dep.test/api/documents/${DOC}/history`],
      ['GET', `https://dep.test/api/documents/${DOC}/versions`],
      ['GET', `https://dep.test/api/documents/${DOC}/activity`],
    ]);
    for (const s of sent) {
      expect(s.headers['if-match']).toBeUndefined();
      expect(s.headers['idempotency-key']).toBeUndefined();
    }
  });

  it('reads the commit that introduced a suggestion with GET (FE-046 criterion 2; HIS-042)', async () => {
    const { ports, sent } = recordingRest(() => ({
      body: {
        suggestion: 'sgOne00000000001',
        time: '2026-11-18T10:30:00Z',
        user: 'u-suggester',
        origin: 'client',
        seq: 7,
      },
    }));
    const answer = await ports.history.suggestionIntroduction(DOC, 'sgOne00000000001');
    expect(answer).toMatchObject({ time: '2026-11-18T10:30:00Z', user: 'u-suggester' });
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      ['GET', `https://dep.test/api/documents/${DOC}/suggestions/sgOne00000000001/introduction`],
    ]);
    expect(sent[0]?.headers['if-match']).toBeUndefined();
  });

  it('sends the bearer token only in the Authorization header, never in the URL', async () => {
    const { ports, sent } = recordingRest(() => ({ body: { items: [], nextCursor: null } }));
    await ports.history.history(DOC);
    expect(sent[0]?.headers['authorization']).toBe('Bearer secret-token');
    expect(sent[0]?.url).not.toContain('secret-token');
  });

  it('creates a version with the caller idempotency key, and without one when none is given', async () => {
    const { ports, sent } = recordingRest(() => ({ status: 201, body: VERSION }));
    await ports.history.createVersion(DOC, cast({ name: 'v1' }), { idempotencyKey: 'key-7' });
    await ports.history.createVersion(DOC, cast({ name: 'v2' }));
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).toBe(`https://dep.test/api/documents/${DOC}/versions`);
    expect(sent[0]?.headers['idempotency-key']).toBe('key-7');
    expect(sent[1]?.headers['idempotency-key']).toBeUndefined();
  });

  it('moves the read marker with If-Match and the seq in the body, and returns the new ETag', async () => {
    const { ports, sent } = recordingRest(() => ({ body: { seq: 7 }, etag: 'W/"8"' }));
    const marker = await ports.history.setReadMarker(DOC, 7, { ifMatch: 'W/"6"' });
    expect(sent[0]).toMatchObject({
      method: 'PUT',
      url: `https://dep.test/api/documents/${DOC}/read-marker`,
      body: { seq: 7 },
    });
    expect(sent[0]?.headers['if-match']).toBe('W/"6"');
    expect(marker).toEqual({ value: { seq: 7 }, etag: 'W/"8"' });
  });

  it('compares, reads attribution and restores with the routes of 05 §6.2', async () => {
    const { ports, sent } = recordingRest((s) => ({ body: s.url.includes('/diff') ? DIFF : {} }));
    await ports.history.diff(DOC, query<'getDiff'>({ from: 1, to: 2 }));
    await ports.history.attribution(DOC, query<'getAttribution'>({ from: 1, to: 2 }));
    await ports.history.restore(DOC, cast({ dryRun: true }));
    expect(sent.map((s) => [s.method, s.url.replace('https://dep.test/api', '')])).toEqual([
      ['GET', `/documents/${DOC}/diff?from=1&to=2`],
      ['GET', `/documents/${DOC}/attribution?from=1&to=2`],
      ['POST', `/documents/${DOC}/restore`],
    ]);
    expect(sent[2]?.body).toEqual({ dryRun: true });
  });

  it('turns a problem document into a PortError carrying its registry code', async () => {
    const { ports } = recordingRest(() => ({
      status: 412,
      body: { code: 'precondition_failed', title: 'stale ETag' },
    }));
    const err = await ports.history.setReadMarker(DOC, 9, { ifMatch: 'W/"1"' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isPortError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('precondition_failed');
  });
});

describe('comments port over REST (PRO-097 criterion 2, the routes)', () => {
  it('lists threads with GET and maps a thread with its ETag', async () => {
    const { ports, sent } = recordingRest((s) =>
      s.url.endsWith('/threads')
        ? { body: { items: [], nextCursor: null } }
        : { body: THREAD, etag: 'W/"2"' },
    );
    await ports.comments.threads(DOC, query<'listThreads'>({}));
    const t = await ports.comments.thread('t-1');
    expect(sent[0]?.url).toBe(`https://dep.test/api/documents/${DOC}/threads`);
    expect(sent[1]?.url).toBe('https://dep.test/api/threads/t-1');
    expect(t.etag).toBe('W/"2"');
  });

  it('creates a thread with an Idempotency-Key', async () => {
    const { ports, sent } = recordingRest(() => ({ status: 201, body: THREAD, etag: 'W/"1"' }));
    await ports.comments.createThread(DOC, cast({ anchor: {}, comment: {} }), {
      idempotencyKey: 'th-1',
    });
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.headers['idempotency-key']).toBe('th-1');
  });

  it('updates a thread only with If-Match', async () => {
    const { ports, sent } = recordingRest(() => ({ body: THREAD, etag: 'W/"4"' }));
    await ports.comments.updateThread('t-1', cast({ state: 'resolved' }), { ifMatch: 'W/"3"' });
    expect(sent[0]).toMatchObject({ method: 'PATCH', url: 'https://dep.test/api/threads/t-1' });
    expect(sent[0]?.headers['if-match']).toBe('W/"3"');
    expect(sent[0]?.body).toEqual({ state: 'resolved' });
  });

  it('deletes a thread with If-Match only when the caller gives one', async () => {
    const { ports, sent } = recordingRest(() => ({ status: 204 }));
    await ports.comments.deleteThread('t-1');
    await ports.comments.deleteThread('t-1', { ifMatch: 'W/"5"' });
    expect(sent[0]?.headers['if-match']).toBeUndefined();
    expect(sent[1]?.headers['if-match']).toBe('W/"5"');
  });

  it('replies, edits and deletes comments on their routes', async () => {
    const { ports, sent } = recordingRest(() => ({ body: COMMENT, etag: 'W/"1"' }));
    await ports.comments.reply('t-1', cast({ body: 'hi' }), { idempotencyKey: 'r-1' });
    await ports.comments.updateComment('c-1', cast({ body: 'edit' }), { ifMatch: 'W/"1"' });
    await ports.comments.deleteComment('c-1', { ifMatch: 'W/"2"' });
    expect(sent.map((s) => [s.method, s.url.replace('https://dep.test/api', '')])).toEqual([
      ['POST', '/threads/t-1/comments'],
      ['PATCH', '/comments/c-1'],
      ['DELETE', '/comments/c-1'],
    ]);
    expect(sent[0]?.headers['idempotency-key']).toBe('r-1');
    expect(sent[1]?.headers['if-match']).toBe('W/"1"');
    expect(sent[2]?.headers['if-match']).toBe('W/"2"');
  });
});

describe('leases and imports over REST (PRO-097, the routes)', () => {
  const region = 'r-1';
  const lease = `https://dep.test/api/documents/${DOC}/regions/${region}/lease`;

  it('acquires, heartbeats and releases a lease; only the heartbeat and an explicit release are conditional', async () => {
    const { ports, sent } = recordingRest(() => ({ body: LEASE, etag: 'W/"1"' }));
    await ports.leases.acquire(DOC, region);
    await ports.leases.heartbeat(DOC, region, { ifMatch: 'W/"1"' });
    await ports.leases.release(DOC, region);
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      ['POST', lease],
      ['PUT', lease],
      ['DELETE', lease],
    ]);
    expect(sent[0]?.headers['if-match']).toBeUndefined();
    expect(sent[1]?.headers['if-match']).toBe('W/"1"');
    expect(sent[2]?.headers['if-match']).toBeUndefined();
  });

  it('requests a Word import with an Idempotency-Key and follows the job', async () => {
    const { ports, sent } = recordingRest(() => ({ body: IMPORT_JOB, etag: 'W/"1"' }));
    await ports.imports.request(DOC, cast({ asset: 'a-1' }), { idempotencyKey: 'imp-1' });
    await ports.imports.get('j-1');
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: `https://dep.test/api/documents/${DOC}/imports`,
    });
    expect(sent[0]?.headers['idempotency-key']).toBe('imp-1');
    expect(sent[1]).toMatchObject({ method: 'GET', url: 'https://dep.test/api/imports/j-1' });
  });
});

describe('the ports exist only when their features are negotiated (PRO-097 criterion 5)', () => {
  const docFor = () => {
    const dep = new MockDepServer({
      welcome: (d) => ({
        ...d,
        features: [
          ...new Set([
            ...((d['features'] as string[] | undefined) ?? []),
            'history',
            'comments',
            'leases',
          ]),
        ],
      }),
    });
    const net = new MemoryNetwork(dep);
    const docId = dep.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
    const make = (features: string[], proxyImports?: boolean) =>
      createDepBackend({
        endpoint: dep.endpoint,
        getToken: async () => dep.mintToken(USERS.editor, { [docId]: 'editor' }),
        features,
        ...(proxyImports === undefined ? {} : { proxyImports }),
        platform: { random: () => 0, ...net.platform() },
      });
    return { make };
  };

  it('offers history, comments and leases when the server announces them and the client asked', async () => {
    const { make } = docFor();
    const b = make(['presence', 'history', 'comments', 'leases']);
    expect(b.history).toBeUndefined();
    await b.connect();
    expect(b.history).toBeDefined();
    expect(b.comments).toBeDefined();
    expect(b.leases).toBeDefined();
    await b.close();
  });

  it('leaves them absent when the server does not announce them, even though the client asked', async () => {
    const dep = new MockDepServer({});
    const net = new MemoryNetwork(dep);
    const docId = dep.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
    const b = createDepBackend({
      endpoint: dep.endpoint,
      getToken: async () => dep.mintToken(USERS.editor, { [docId]: 'editor' }),
      features: ['presence', 'history', 'comments', 'leases'],
      platform: { random: () => 0, ...net.platform() },
    });
    await b.connect();
    expect(b.features.has('history')).toBe(false);
    expect(b.history).toBeUndefined();
    expect(b.comments).toBeUndefined();
    expect(b.leases).toBeUndefined();
    await b.close();
  });

  it('leaves them absent when the client did not ask, even though the server announces them', async () => {
    const { make } = docFor();
    const b = make(['presence']);
    await b.connect();
    expect(b.features.has('history')).toBe(false);
    expect(b.history).toBeUndefined();
    expect(b.comments).toBeUndefined();
    expect(b.leases).toBeUndefined();
    await b.close();
  });

  it('offers imports only when the host proxies them (no feature name, D16)', async () => {
    const { make } = docFor();
    const plain = make(['history']);
    await plain.connect();
    expect(plain.imports).toBeUndefined();
    await plain.close();
    const proxied = make(['history'], true);
    await proxied.connect();
    expect(proxied.imports).toBeDefined();
    await proxied.close();
  });
});
