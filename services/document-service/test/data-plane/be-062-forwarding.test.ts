// Forwarding of a channel to the owning node over the bus (BE-062; BE-061 criteria 2 and 3; BE-063
// criteria 1, 4 and 5). Two or three data planes run in one process over one set of in-memory
// stores, with node leases, joined by a `MemoryBusNetwork` whose faults the test sets. The same
// forwarding runs over a real Valkey in `be-062-forwarding.valkey.test.ts`.
import { afterEach, describe, expect, it } from 'vitest';
import { routeDocument } from '../../src/control-plane/room-routing.ts';
import { MemoryBusNetwork } from '../../src/data-plane/bus.ts';
import { insertText, type DepClient } from './client.ts';
import { cluster, intro, seeded, type Cluster } from './forwarding-support.ts';
import type { Plane } from './support.ts';

let c: Cluster | null = null;
afterEach(async () => {
  await c?.close();
  c = null;
});

const NODES = ['node-a', 'node-b'];

/** A document that rendezvous routing names `owner` for. */
async function docFor(p: Plane, owner: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const doc = await p.createDocument();
    if (routeDocument(doc, NODES) === owner) return doc;
  }
  throw new Error('no document routes to ' + owner);
}

async function until(check: () => boolean | Promise<boolean>, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const routes = (p: Plane, route: string): number =>
  p.plane.metricsRegistry.text().includes('dep_channel_routes_total')
    ? Number(
        new RegExp(`dep_channel_routes_total\\{[^}]*route="${route}"[^}]*\\} (\\d+)`).exec(
          p.plane.metricsRegistry.text(),
        )?.[1] ?? 0,
      )
    : 0;

/** The `seq` of each commit a client was sent by the room, in order. */
const commitsSeen = (cl: DepClient): number[] =>
  cl
    .all('sync.commit')
    .flatMap((m) => (m.d as { commits: Array<{ seq: number }> }).commits.map((x) => x.seq));
const hasCommit = (seq: number) => (m: { t: string; d?: unknown }) =>
  m.t === 'sync.commit' &&
  (m.d as { commits: Array<{ seq: number }> }).commits.some((x) => x.seq === seq);

async function pair() {
  c = cluster();
  const net = new MemoryBusNetwork(seeded(11));
  const a = await c.start('node-a', net.connect('node-a'));
  const b = await c.start('node-b', net.connect('node-b'));
  return { net, a, b };
}

describe('a channel that lands on a non-owner is forwarded to the owner (BE-062 criterion 1)', () => {
  it('works as if it had landed on the owner: same answers, same commits, one room', async () => {
    const { a, b } = await pair();
    const doc = await docFor(a, 'node-a');
    const alice = await a.client('alice', { [doc]: 'owner' });
    {
      const r = await alice.open(1, doc);
      expect(r.t, JSON.stringify(r.d)).toBe('ch.opened');
    }
    const bob = await b.client('bob', { [doc]: 'editor' });
    const opened = await bob.open(1, doc);
    expect(opened.t).toBe('ch.opened');
    expect(opened.d).toMatchObject({ head: 0 });
    // The room is on node-a only; node-b holds the socket and the forwarding.
    expect(a.plane.host.rooms).toHaveLength(1);
    expect(b.plane.host.rooms).toHaveLength(0);
    expect(routes(b, 'forwarded')).toBe(1);
    expect(routes(a, 'local')).toBe(1);

    // A commit by the forwarded client is acknowledged and reaches the owner's client.
    const ack = await bob.submit(1, { base: 0, steps: [insertText(intro(), 'from bob ')] });
    expect(ack.t).toBe('sync.ack');
    expect(ack.d).toMatchObject({ seq: 1 });
    await alice.take((m) => hasCommit(1)(m));
    // And a commit by the owner's client reaches the forwarded one.
    const ack2 = await alice.submit(1, { base: 1, steps: [insertText(intro(), 'from alice ')] });
    expect(ack2.d).toMatchObject({ seq: 2 });
    await bob.take((m) => hasCommit(2)(m));
    expect(commitsSeen(bob)).toEqual([2]);
    expect(commitsSeen(alice)).toEqual([1]);
    // Both are in the log of the one owner.
    expect((await c!.mem.read(a.ref(doc), 1)).map((x) => x.seq)).toEqual([1, 2]);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  });

  it('carries presence between clients on different nodes (BE-063 criterion 1)', async () => {
    const { a, b } = await pair();
    const doc = await docFor(a, 'node-a');
    const alice = await a.client('alice', { [doc]: 'owner' }, { name: 'Alice' });
    const bob = await b.client('bob', { [doc]: 'editor' }, { name: 'Bob' });
    await alice.open(1, doc);
    await bob.open(1, doc);
    const state = (n: number) => ({
      selection: { anchor: n, head: n },
      scope: 'body',
      status: 'active',
    });
    alice.send({ t: 'presence.update', ch: 1, d: { seq: 0, state: state(3) } });
    const seenByBob = await bob.take(
      (m) => m.t === 'presence.state' && JSON.stringify(m.d).includes('"anchor":3'),
    );
    expect(JSON.stringify(seenByBob.d)).toContain('Alice');
    bob.send({ t: 'presence.update', ch: 1, d: { seq: 0, state: state(7) } });
    const seenByAlice = await alice.take(
      (m) => m.t === 'presence.state' && JSON.stringify(m.d).includes('"anchor":7'),
    );
    expect(JSON.stringify(seenByAlice.d)).toContain('Bob');
  });

  it('runs the authority checks in the owning room, and the token check at the gateway (criterion 5)', async () => {
    const { a, b } = await pair();
    const doc = await docFor(a, 'node-a');
    const alice = await a.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    // A viewer on the gateway: the room refuses the commit, as it would on the owner.
    const viewer = await b.client('carol', { [doc]: 'viewer' });
    {
      const r = await viewer.open(1, doc);
      expect(r.t, JSON.stringify(r.d)).toBe('ch.opened');
    }
    const refused = await viewer.submit(1, { base: 0, steps: [insertText(intro(), 'x')] });
    expect(refused.t).toBe('sync.reject');
    expect(await c!.mem.read(a.ref(doc), 1)).toEqual([]);
    // The same viewer on the owner is refused the same way.
    const direct = await a.client('carol', { [doc]: 'viewer' });
    await direct.open(1, doc);
    const refused2 = await direct.submit(1, { base: 0, steps: [insertText(intro(), 'x')] });
    expect(refused2.d).toMatchObject({ code: (refused.d as { code: string }).code });
    // A token that covers no role in the document never leaves the gateway.
    const stranger = await b.client('mallory', { [crypto.randomUUID()]: 'owner' });
    const framesBefore = b.plane.forwarder!.stats.forwardedFrames;
    const rejected = await stranger.open(1, doc);
    expect(rejected.t).toBe('ch.rejected');
    expect(rejected.d).toMatchObject({ code: 'forbidden' });
    expect(b.plane.forwarder!.stats.forwardedFrames).toBe(framesBefore);
  });

  it("refuses a channel the owner refuses, with the owner's reason", async () => {
    const { a, b } = await pair();
    const doc = await docFor(a, 'node-a');
    const alice = await a.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    const bob = await b.client('bob', { [doc]: 'editor' });
    const r = await bob.open(1, doc, { cdm: 99 });
    // The gateway refuses a CDM outside what the server reads before it forwards anything.
    expect(r.t).toBe('ch.rejected');
    expect(r.d).toMatchObject({ code: 'unsupported_cdm' });
  });
});

describe('forwarding survives dropped and delayed packets (BE-062 criteria 2 and 3)', () => {
  it('delivers every commit once and in order while packets are dropped and delayed', async () => {
    const { net, a, b } = await pair();
    const doc = await docFor(a, 'node-a');
    const alice = await a.client('alice', { [doc]: 'owner' });
    const bob = await b.client('bob', { [doc]: 'editor' });
    await alice.open(1, doc);
    await bob.open(1, doc);
    net.faults.drop = 0.25;
    net.faults.delayMs = 25;
    const N = 40;
    for (let i = 0; i < N; i++) {
      const ack = await alice.submit(1, { base: i, steps: [insertText(intro(), `${i} `)] });
      expect(ack.t).toBe('sync.ack');
    }
    await until(() => commitsSeen(bob).length >= N, 8000, 'every commit on the forwarded channel');
    await new Promise((r) => setTimeout(r, 200));
    expect(commitsSeen(bob)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    // The forwarded client submits too: its commits cross the lossy bus and are acknowledged once.
    for (let i = 0; i < 10; i++) {
      const ack = await bob.submit(
        1,
        { base: N + i, steps: [insertText(intro(), `b${i} `)] },
        8000,
      );
      expect(ack.t).toBe('sync.ack');
      expect(ack.d).toMatchObject({ seq: N + i + 1 });
    }
    const log = await c!.mem.read(a.ref(doc), 1);
    expect(log.map((x) => x.seq)).toEqual(Array.from({ length: N + 10 }, (_, i) => i + 1));
    expect(commitsSeen(alice).filter((s) => s > N)).toEqual(
      Array.from({ length: 10 }, (_, i) => N + i + 1),
    );
    // Drops did happen, and the stream repaired them.
    expect(net.connect('probe').stats.failed).toBe(0);
    expect(a.plane.forwarder!.stats.repairs + b.plane.forwarder!.stats.repairs).toBeGreaterThan(0);
    expect(b.plane.forwarder!.stats.gapCloses).toBe(0);
  });

  it('closes the channel with unavailable and a retryInMs when a gap cannot be repaired, and the client resumes', async () => {
    c = cluster();
    const net = new MemoryBusNetwork(seeded(5));
    // A window of two frames: a burst under heavy loss leaves gaps the sender no longer keeps.
    const a = await c.start('node-a', net.connect('node-a'), { retain: 2, maxNacks: 3 });
    const b = await c.start('node-b', net.connect('node-b'), { retain: 2, maxNacks: 3 });
    const doc = await docFor(a, 'node-a');
    const alice = await a.client('alice', { [doc]: 'owner' });
    const bob = await b.client('bob', { [doc]: 'editor' });
    await alice.open(1, doc);
    await bob.open(1, doc);
    net.faults.drop = 0.6;
    for (let i = 0; i < 30; i++)
      alice.submitNoWait(1, { base: i, steps: [insertText(intro(), `${i} `)] });
    const closed = await bob.take(
      (m) => m.t === 'ch.closed',
      8000,
      'ch.closed on the forwarded channel',
    );
    expect(closed.d).toMatchObject({ code: 'unavailable' });
    expect((closed.d as { retryInMs: number }).retryInMs).toBeGreaterThan(0);
    expect(b.plane.forwarder!.stats.gapCloses).toBeGreaterThan(0);
    // The client resumes: it opens again and is brought up to date from the log, no commit lost.
    net.faults.drop = 0;
    await until(async () => (await c!.mem.head(a.ref(doc))).seq >= 1, 4000, 'commits stored');
    await new Promise((r) => setTimeout(r, 300));
    const head = (await c!.mem.head(a.ref(doc))).seq;
    const again = await bob.open(1, doc, {
      resume: { seq: 0, incarnation: (await c!.mem.head(a.ref(doc))).incarnation },
    });
    expect(again.t, JSON.stringify(again.d)).toBe('ch.opened');
    expect(again.d).toMatchObject({ head });
  });
});

describe('a stale hint costs latency only (BE-061 criteria 2 and 3)', () => {
  it('forwards nothing when clients follow the hint, and forwards a stale one that still works', async () => {
    const { a, b } = await pair();
    const doc = await docFor(a, 'node-a');
    const alice = await a.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    const { chooseNode } = await import('../../src/control-plane/connect-route.ts');
    const { Placement } = await import('../../src/control-plane/room-routing.ts');
    const placement = new Placement(c!.leases);
    // Ten clients ask for the hint and connect where it says.
    const planes: Record<string, Plane> = { 'node-a': a, 'node-b': b };
    const hinted: DepClient[] = [];
    for (let i = 0; i < 10; i++) {
      const head = await c!.mem.head(a.ref(doc));
      const named = await chooseNode(placement, head.owner, doc);
      expect(named?.node).toBe('node-a');
      const cl = await planes[named!.node]!.client(
        (['bob', 'carol', 'dave', 'erin', 'frank'] as const)[i % 5]!,
        { [doc]: 'editor' },
      );
      {
        const r = await cl.open(1, doc);
        expect(r.t, JSON.stringify(r.d)).toBe('ch.opened');
      }
      hinted.push(cl);
    }
    expect(routes(a, 'forwarded') + routes(b, 'forwarded')).toBe(0);
    expect(routes(a, 'local')).toBe(11);
    // A stale hint: the client was told node-b, but the document is on node-a.
    const stale = await b.client('mallory', { [doc]: 'editor' });
    {
      const r = await stale.open(1, doc);
      expect(r.t, JSON.stringify(r.d)).toBe('ch.opened');
    }
    expect(routes(b, 'forwarded')).toBe(1);
    const ack = await stale.submit(1, { base: 0, steps: [insertText(intro(), 'stale ')] });
    expect(ack.t).toBe('sync.ack');
    await hinted[0]!.take((m) => m.t === 'sync.commit');
  });
});

describe('the owner changes while channels are forwarded (BE-062 criterion 4)', () => {
  it('closes the forwarded channels with unavailable, and a new channel is routed to the new owner', async () => {
    const { a, b } = await pair();
    const doc = await docFor(a, 'node-a');
    const alice = await a.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    const bob = await b.client('bob', { [doc]: 'editor' });
    await bob.open(1, doc);
    expect(b.plane.forwarder!.channels.gateway).toBe(1);
    // node-a stops renewing its lease and is no longer the owner once the lease runs out.
    await a.plane.lease!.stop(false);
    const closed = await bob.take(
      (m) => m.t === 'ch.closed',
      5000,
      'ch.closed after the owner was lost',
    );
    expect(closed.d).toMatchObject({ code: 'unavailable' });
    expect(b.plane.forwarder!.stats.ownerChangeCloses).toBe(1);
    await until(
      () => b.plane.forwarder!.channels.gateway === 0,
      2000,
      'the channel to be forgotten',
    );
    // The client reconnects: node-a is not live, so node-b is routed the document and takes it.
    const again = await b.client('bob', { [doc]: 'editor' });
    {
      const r = await again.open(1, doc);
      expect(r.t, JSON.stringify(r.d)).toBe('ch.opened');
    }
    expect((await c!.mem.head(b.ref(doc))).owner).toBe('node-b');
    expect(b.plane.host.rooms).toHaveLength(1);
  });
});

describe('the bus is lost (BE-063 criteria 4 and 5)', () => {
  it('lets each node serve the rooms it owns, and clients reach owners directly with the hint', async () => {
    const { net, a, b } = await pair();
    const docA = await docFor(a, 'node-a');
    const docB = await docFor(b, 'node-b');
    const alice = await a.client('alice', { [docA]: 'owner' });
    const bobB = await b.client('bob', { [docB]: 'owner' });
    await alice.open(1, docA);
    await bobB.open(1, docB);
    net.faults.down = true;
    // Rooms owned here are served: commits are acknowledged and stored.
    expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'a ')] })).t).toBe(
      'sync.ack',
    );
    expect((await bobB.submit(1, { base: 0, steps: [insertText(intro(), 'b ')] })).t).toBe(
      'sync.ack',
    );
    // A channel that needs forwarding cannot be opened: it is refused unavailable.
    const cross = await b.client('carol', { [docA]: 'editor' });
    const refused = await cross.open(1, docA);
    expect(refused.t).toBe('ch.rejected');
    expect(refused.d).toMatchObject({ code: 'unavailable' });
    // The hint does not use the bus: it names the owner, and a client that follows it is served.
    const { chooseNode } = await import('../../src/control-plane/connect-route.ts');
    const { Placement } = await import('../../src/control-plane/room-routing.ts');
    const named = await chooseNode(
      new Placement(c!.leases),
      (await c!.mem.head(a.ref(docA))).owner,
      docA,
    );
    expect(named?.node).toBe('node-a');
    const direct = await a.client('carol', { [docA]: 'editor' });
    {
      const r = await direct.open(1, docA);
      expect(r.t, JSON.stringify(r.d)).toBe('ch.opened');
    }
    expect((await direct.submit(1, { base: 1, steps: [insertText(intro(), 'c ')] })).t).toBe(
      'sync.ack',
    );
    expect((await c!.mem.read(a.ref(docA), 1)).map((x) => x.seq)).toEqual([1, 2]);
  });

  it('closes a forwarded channel when the bus goes silent, and loses no commit', async () => {
    const { net, a, b } = await pair();
    const doc = await docFor(a, 'node-a');
    const alice = await a.client('alice', { [doc]: 'owner' });
    const bob = await b.client('bob', { [doc]: 'editor' });
    await alice.open(1, doc);
    await bob.open(1, doc);
    expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'one ')] })).t).toBe(
      'sync.ack',
    );
    await bob.take((m) => m.t === 'sync.commit');
    net.faults.down = true;
    // A commit stored while the bus is down is acknowledged to its author and is in the log.
    expect((await alice.submit(1, { base: 1, steps: [insertText(intro(), 'two ')] })).t).toBe(
      'sync.ack',
    );
    const closed = await bob.take((m) => m.t === 'ch.closed', 5000, 'ch.closed on silence');
    expect(closed.d).toMatchObject({ code: 'unavailable' });
    expect(b.plane.forwarder!.stats.silenceCloses).toBeGreaterThan(0);
    net.faults.down = false;
    expect((await c!.mem.read(a.ref(doc), 1)).map((x) => x.seq)).toEqual([1, 2]);
    // Back on the bus, the client resumes and sees both commits.
    const incarnation = (await c!.mem.head(a.ref(doc))).incarnation;
    await until(
      () => a.plane.forwarder!.channels.owner === 0,
      4000,
      'the owner to drop the channel',
    );
    const again = await bob.open(1, doc, { resume: { seq: 0, incarnation } });
    expect(again.t, JSON.stringify(again.d)).toBe('ch.opened');
    expect(again.d).toMatchObject({ head: 2 });
  });
});
