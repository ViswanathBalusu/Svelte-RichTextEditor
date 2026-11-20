// HIS-003 criterion 3 at the data plane (08 §2, last paragraph; owner decision 24): a session's
// record is stored before its channel opens, from what the connection itself gives (the
// `User-Agent` of the upgrade request and `hello.client.version`), once per session and document.
// Real WebSocket clients against the data plane over in-memory stores; the PostgreSQL table is in
// test/postgres/his-003-session-records.pg.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemorySessionRecordStore,
  SessionRecords,
  type SessionRecord,
} from '../../src/control-plane/session-records.ts';
import { MemoryBusNetwork } from '../../src/data-plane/bus.ts';
import type { ErrorContext, SessionOpened } from '../../src/seams.ts';
import { DepClient, insertText } from './client.ts';
import { cluster, docFor, intro, seeded, type Cluster } from './forwarding-support.ts';
import { startPlane, type Plane } from './support.ts';

const EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0';

interface Reported {
  where: string;
  context: ErrorContext | undefined;
}

let p: Plane | null = null;
let group: Cluster | null = null;
const sockets: DepClient[] = [];
afterEach(async () => {
  for (const c of sockets.splice(0)) c.terminate();
  await p?.close();
  p = null;
  await group?.close();
  group = null;
});

/** A plane whose sessions are recorded as the service composes it (server.ts). */
async function recordingPlane(
  opts: {
    hook?: (open: SessionOpened, records: SessionRecords) => Promise<void> | void;
  } = {},
) {
  const records = new SessionRecords(new MemorySessionRecordStore());
  const seen: SessionOpened[] = [];
  const reported: Reported[] = [];
  p = await startPlane({
    deps: {
      sessionOpened: (open) => {
        seen.push(open);
        return opts.hook ? opts.hook(open, records) : records.opened(open);
      },
    },
    settings: { onError: (_e, where, context) => reported.push({ where, context }) },
  });
  return { plane: p, records, seen, reported };
}

/** A client that says `hello` with its own `User-Agent` header and client. */
async function connect(
  plane: Plane,
  user: 'alice' | 'bob' | 'carol' | 'dave',
  docs: Record<string, 'owner' | 'editor' | 'viewer'>,
  opts: { userAgent?: string; client?: { name: string; version: string }; name?: string } = {},
): Promise<{ client: DepClient; session: string; token: string }> {
  const token = plane.tokens.issue({
    user,
    docs,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
  });
  const client = await DepClient.connect(
    plane.url,
    opts.userAgent !== undefined ? { headers: { 'User-Agent': opts.userAgent } } : {},
  );
  sockets.push(client);
  const welcome = await client.hello(token, opts.client ? { client: opts.client } : {});
  expect(welcome.t, JSON.stringify(welcome.d)).toBe('welcome');
  return { client, session: welcome.d!['session'] as string, token };
}

describe('a session is recorded before its channel opens (HIS-003 criterion 3)', () => {
  it('stores the user agent family, its major version and the client version, with the surrogate', async () => {
    const { plane, records, seen } = await recordingPlane();
    const doc = await plane.createDocument();
    const a = await connect(
      plane,
      'alice',
      { [doc]: 'owner' },
      {
        userAgent: EDGE,
        client: { name: '@docedit/element', version: '1.4.2' },
        name: 'Alice Example',
      },
    );
    // `hello` alone records nothing: the record belongs to a document.
    expect(seen).toEqual([]);
    expect((await a.client.open(1, doc)).t).toBe('ch.opened');
    const expected: SessionRecord = {
      tenant: plane.tenant,
      document: doc,
      session: a.session,
      user: 'alice',
      userAgentFamily: 'edge',
      userAgentMajor: 137,
      clientVersion: '1.4.2',
    };
    expect(await records.of(plane.tenant, doc)).toEqual([expected]);

    // What the data plane hands over: the session, the surrogate, the header and the version, and
    // nothing else of the connection (no address, origin, host `sub`, name, token or client name).
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!).sort()).toEqual([
      'clientVersion',
      'doc',
      'session',
      'tenant',
      'user',
      'userAgent',
    ]);
    expect(seen[0]).toEqual({
      tenant: plane.tenant,
      doc,
      session: a.session,
      user: 'alice',
      userAgent: EDGE,
      clientVersion: '1.4.2',
    });
    const handed = JSON.stringify(seen[0]);
    for (const secret of ['host-alice', 'Alice Example', a.token, '127.0.0.1', '@docedit/element'])
      expect(handed, secret).not.toContain(secret);
    // And the stored record holds no text of the header at all.
    const stored = JSON.stringify(await records.of(plane.tenant, doc));
    for (const part of ['Mozilla', 'Windows', 'AppleWebKit', 'host-alice', 'Alice Example'])
      expect(stored, part).not.toContain(part);
  });

  it('opens the channel only after the record is stored, so every commit of a session has one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { plane, records } = await recordingPlane({
      hook: async (open, r) => {
        await gate;
        await r.opened(open);
      },
    });
    const doc = await plane.createDocument();
    const a = await connect(plane, 'alice', { [doc]: 'owner' }, { userAgent: FIREFOX });
    const opening = a.client.open(1, doc);
    // While the record is not stored the client has no answer, so it cannot submit on the channel.
    await new Promise((r) => setTimeout(r, 150));
    expect(a.client.all('ch.opened')).toEqual([]);
    expect(await records.of(plane.tenant, doc)).toEqual([]);
    release();
    expect((await opening).t).toBe('ch.opened');
    expect(await records.get(plane.tenant, doc, a.session)).toMatchObject({
      userAgentFamily: 'firefox',
      userAgentMajor: 142,
    });

    const ack = await a.client.submit(1, { base: 0, steps: [insertText(intro(), 'x')] });
    expect(ack.t).toBe('sync.ack');
    const [commit] = await plane.stores.logs.read(plane.ref(doc));
    expect(commit!.session).toBe(a.session);
    // The session a commit names leads to its record.
    expect(await records.get(plane.tenant, doc, commit!.session!)).not.toBeNull();
  });

  it('writes one record per session and document, also for a reader, and none again on reopening', async () => {
    const { plane, records, seen } = await recordingPlane();
    const one = await plane.createDocument();
    const two = await plane.createDocument();
    const a = await connect(
      plane,
      'alice',
      { [one]: 'owner', [two]: 'owner' },
      { userAgent: EDGE, client: { name: 'c', version: '2.0.0' } },
    );
    // A second session of another user, who only reads, with no header and a free-text version.
    const d = await connect(
      plane,
      'dave',
      { [one]: 'viewer' },
      { client: { name: 'c', version: 'nightly build of Dave Example' } },
    );
    expect((await a.client.open(1, one)).t).toBe('ch.opened');
    expect((await a.client.open(2, two)).t).toBe('ch.opened');
    expect((await d.client.open(1, one)).t).toBe('ch.opened');
    // The same session closes its channel and opens the document again.
    a.client.send({ t: 'ch.close', ch: 1 });
    expect((await a.client.open(3, one)).t).toBe('ch.opened');

    expect(seen.map((s) => [s.session, s.doc])).toEqual([
      [a.session, one],
      [a.session, two],
      [d.session, one],
    ]);
    const ofOne = await records.of(plane.tenant, one);
    expect(ofOne).toHaveLength(2);
    expect(ofOne).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ session: a.session, user: 'alice', clientVersion: '2.0.0' }),
        {
          tenant: plane.tenant,
          document: one,
          session: d.session,
          user: 'dave',
          userAgentFamily: 'other',
          userAgentMajor: null,
          clientVersion: null,
        },
      ]),
    );
    expect((await records.of(plane.tenant, two)).map((r) => r.session)).toEqual([a.session]);
    expect(JSON.stringify(ofOne)).not.toContain('Dave Example');
  });

  it('records nothing for a channel that is refused before it reaches the document', async () => {
    const { plane, records, seen } = await recordingPlane();
    const doc = await plane.createDocument();
    const missing = '0190f2a4-0000-7000-8000-00000000dead';
    const a = await connect(plane, 'alice', { [doc]: 'owner', [missing]: 'owner' });
    // No such document, another CDM version, and a document the token does not name.
    expect((await a.client.open(1, missing)).d).toMatchObject({ code: 'not_found' });
    expect((await a.client.open(2, doc, { cdm: 2 })).t).toBe('ch.rejected');
    const other = await plane.createDocument();
    expect((await a.client.open(3, other)).d).toMatchObject({ code: 'forbidden' });
    expect(seen).toEqual([]);
    expect(await records.of(plane.tenant, doc)).toEqual([]);
  });

  it('refuses the channel with `unavailable` when the record cannot be stored, and tries again on the next open', async () => {
    let fail = true;
    const { plane, records, reported } = await recordingPlane({
      hook: (open, r) => {
        if (fail) throw new Error('the database is unreachable');
        return r.opened(open);
      },
    });
    const doc = await plane.createDocument();
    const a = await connect(plane, 'alice', { [doc]: 'owner' }, { userAgent: EDGE });
    const refused = await a.client.open(1, doc);
    expect(refused.t).toBe('ch.rejected');
    expect(refused.d).toMatchObject({ code: 'unavailable' });
    // The failure is reported by name with the session and the document, never to the client.
    expect(reported).toEqual([
      { where: 'session.opened', context: { session: a.session, tenant: plane.tenant, doc } },
    ]);
    expect(JSON.stringify(refused.d)).not.toContain('database');
    expect(await records.of(plane.tenant, doc)).toEqual([]);
    // The channel never opened, so nothing can be submitted on it.
    const answer = await a.client.submit(1, { base: 0, steps: [insertText(intro(), 'x')] });
    expect(answer.t).toBe('error');
    expect(answer.d).toMatchObject({ code: 'bad_message' });
    expect(await plane.stores.logs.read(plane.ref(doc))).toEqual([]);

    fail = false;
    expect((await a.client.open(1, doc)).t).toBe('ch.opened');
    expect((await records.of(plane.tenant, doc)).map((r) => r.session)).toEqual([a.session]);
    expect(reported).toHaveLength(1);
  });

  it('leaves a plane without the hook as it was: channels open and nothing is recorded', async () => {
    p = await startPlane();
    const doc = await p.createDocument();
    const a = await connect(p, 'alice', { [doc]: 'owner' }, { userAgent: EDGE });
    expect((await a.client.open(1, doc)).t).toBe('ch.opened');
    expect(p.errors).toEqual([]);
  });
});

describe('a forwarded channel is recorded by the node that holds the connection (HIS-003; BE-062)', () => {
  it('stores the record on the gateway before the owner opens the channel', async () => {
    group = cluster();
    const records = new SessionRecords(new MemorySessionRecordStore());
    const calls: Array<{ node: string; open: SessionOpened }> = [];
    const hookOf = (node: string) => ({
      sessionOpened: (open: SessionOpened) => {
        calls.push({ node, open });
        return records.opened(open);
      },
    });
    const net = new MemoryBusNetwork(seeded(11));
    const a = await group.start('node-a', net.connect('node-a'), {}, hookOf('node-a'));
    const b = await group.start('node-b', net.connect('node-b'), {}, hookOf('node-b'));
    const doc = await docFor(a, 'node-a');
    // Alice lands on the owner, Bob on the other node: his channel is forwarded.
    const alice = await connect(a, 'alice', { [doc]: 'owner' }, { userAgent: EDGE });
    expect((await alice.client.open(1, doc)).t).toBe('ch.opened');
    const bob = await connect(
      b,
      'bob',
      { [doc]: 'editor' },
      { userAgent: FIREFOX, client: { name: 'c', version: '3.1.0' } },
    );
    expect((await bob.client.open(1, doc)).t).toBe('ch.opened');
    expect(a.plane.host.rooms).toHaveLength(1);
    expect(b.plane.host.rooms).toHaveLength(0);

    // Each session is recorded once, by the node that has its socket.
    expect(calls.map((c) => [c.node, c.open.session])).toEqual([
      ['node-a', alice.session],
      ['node-b', bob.session],
    ]);
    expect(await records.get(group.tenant, doc, bob.session)).toEqual({
      tenant: group.tenant,
      document: doc,
      session: bob.session,
      user: 'bob',
      userAgentFamily: 'firefox',
      userAgentMajor: 142,
      clientVersion: '3.1.0',
    });
    // A commit of the forwarded session is stored by the owner and names the recorded session.
    const ack = await bob.client.submit(1, { base: 0, steps: [insertText(intro(), 'b')] });
    expect(ack.t).toBe('sync.ack');
    const [commit] = await group.mem.read(a.ref(doc), 1);
    expect(commit!.session).toBe(bob.session);
    expect(await records.get(group.tenant, doc, commit!.session!)).not.toBeNull();
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  });

  it('does not ask the owner to open the channel when the record cannot be stored', async () => {
    group = cluster();
    const net = new MemoryBusNetwork(seeded(11));
    const a = await group.start('node-a', net.connect('node-a'));
    const b = await group.start(
      'node-b',
      net.connect('node-b'),
      {},
      {
        sessionOpened: () => Promise.reject(new Error('the database is unreachable')),
      },
    );
    const doc = await docFor(a, 'node-a');
    const bob = await connect(b, 'bob', { [doc]: 'editor' }, { userAgent: FIREFOX });
    const refused = await bob.client.open(1, doc);
    expect(refused.t).toBe('ch.rejected');
    expect(refused.d).toMatchObject({ code: 'unavailable' });
    // The owner was never asked: it holds no room for the document.
    expect(a.plane.host.rooms).toHaveLength(0);
    expect(b.plane.forwarder!.stats.opened).toBe(0);
  });
});
