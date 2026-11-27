// BE-073 and BE-074: a hot document runs on the node dedicated to it, and a tenant with a home
// region is served by the nodes of that region. Several data planes run in one process over one
// set of in-memory stores, with node leases and a `MemoryBusNetwork` (the forwarding of BE-062).
// They are separate nodes of the service, not separate operating-system processes, and no core is
// pinned: what is tested is the routing, the forwarding and the epoch claim, not the isolation of
// a process.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryBusNetwork } from '../../src/data-plane/bus.ts';
import { MemoryHomeRegions } from '../../src/storage/home-regions.ts';
import { insertText } from './client.ts';
import { cluster, docFor, intro, seeded, type Cluster } from './forwarding-support.ts';

let c: Cluster | null = null;
afterEach(async () => {
  await c?.close();
  c = null;
});

const roomsOf = (c: Cluster, node: string): number => c.planes.get(node)!.plane.host.rooms.length;

describe('a hot document runs on the node dedicated to it (BE-073)', () => {
  async function trio() {
    c = cluster();
    const net = new MemoryBusNetwork(seeded(21));
    const g1 = await c.start('node-g1', net.connect('node-g1'));
    const g2 = await c.start('node-g2', net.connect('node-g2'));
    const hot = await g1.createDocument();
    const h = await c.start('node-h', net.connect('node-h'), {}, { traits: { dedicated: hot } });
    return { g1, g2, h, hot };
  }

  it('announces what it is dedicated to on its lease row', async () => {
    const { hot } = await trio();
    const live = await c!.leases.live();
    expect(live.find((n) => n.node === 'node-h')?.dedicated).toBe(hot);
    expect(live.find((n) => n.node === 'node-g1')?.dedicated).toBeNull();
  });

  it('opens the room of the hot document on that node, whichever node got the channel, and takes the epoch there', async () => {
    const { g1, g2, h, hot } = await trio();
    const before = await c!.mem.head(g1.ref(hot));
    expect(before).toMatchObject({ owner: null, epoch: 0 });

    const alice = await g2.client('alice', { [hot]: 'editor' });
    expect((await alice.open(1, hot)).t).toBe('ch.opened');
    expect(roomsOf(c!, 'node-h')).toBe(1);
    expect(roomsOf(c!, 'node-g1')).toBe(0);
    expect(roomsOf(c!, 'node-g2')).toBe(0);

    // The dedicated node took the epoch like any other owner: one claim, one epoch higher.
    const after = await c!.mem.head(g1.ref(hot));
    expect(after.owner).toBe('node-h');
    expect(after.epoch).toBe(before.epoch + 1);

    // And it is a working room: a commit through the forwarded channel is acknowledged.
    const ack = await alice.submit(1, { base: 0, steps: [insertText(intro(), 'hot ')] });
    expect(ack.d).toMatchObject({ seq: 1 });
    expect((await c!.mem.read(g1.ref(hot), 1)).map((x) => x.seq)).toEqual([1]);
    expect(h.errors).toEqual([]);
  });

  it('serves no other document: a channel that lands on it is forwarded to a general node', async () => {
    const { g1, h, hot } = await trio();
    const other = await g1.createDocument();
    expect(other).not.toBe(hot);
    const bob = await h.client('bob', { [other]: 'editor' });
    expect((await bob.open(1, other)).t).toBe('ch.opened');
    expect(roomsOf(c!, 'node-h')).toBe(0);
    expect(roomsOf(c!, 'node-g1') + roomsOf(c!, 'node-g2')).toBe(1);
    const head = await c!.mem.head(g1.ref(other));
    expect(['node-g1', 'node-g2']).toContain(head.owner);
  });

  it('falls back to a general node while the dedicated node is not live', async () => {
    const { g1, g2, h, hot } = await trio();
    await h.plane.lease!.stop(false);
    for (let i = 0; i < 200 && (await c!.leases.alive('node-h')); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(await c!.leases.alive('node-h')).toBe(false);
    const alice = await g2.client('alice', { [hot]: 'editor' });
    expect((await alice.open(1, hot)).t).toBe('ch.opened');
    expect(['node-g1', 'node-g2']).toContain((await c!.mem.head(g1.ref(hot))).owner);
  });
});

describe('a tenant with a home region is served by the nodes of that region (BE-074)', () => {
  async function regions(start: ReadonlyArray<'eu' | 'us'> = ['eu', 'us']) {
    c = cluster();
    const net = new MemoryBusNetwork(seeded(31));
    const homeRegions = new MemoryHomeRegions();
    const nodes: Record<string, Awaited<ReturnType<Cluster['start']>>> = {};
    for (const region of start)
      nodes[region] = await c.start(
        `node-${region}`,
        net.connect(`node-${region}`),
        {},
        { traits: { region }, homeRegions },
      );
    const anyPlane = nodes[start[0]!]!;
    return { nodes, homeRegions, tenant: anyPlane.tenant, anyPlane };
  }

  it('forwards a channel from a gateway in another region to the home region, and the room and the log are there', async () => {
    const { nodes, homeRegions, tenant, anyPlane } = await regions();
    await homeRegions.assign(tenant, 'eu', 'operator');
    const doc = await anyPlane.createDocument();
    const alice = await nodes['us']!.client('alice', { [doc]: 'editor' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    expect(roomsOf(c!, 'node-eu')).toBe(1);
    expect(roomsOf(c!, 'node-us')).toBe(0);
    const ack = await alice.submit(1, { base: 0, steps: [insertText(intro(), 'eu ')] });
    expect(ack.d).toMatchObject({ seq: 1 });
    expect((await c!.mem.head(anyPlane.ref(doc))).owner).toBe('node-eu');
  });

  it('lets a document have a region of its own, which wins over its tenant', async () => {
    const { nodes, homeRegions, tenant, anyPlane } = await regions();
    await homeRegions.assign(tenant, 'eu', 'operator');
    const doc = await anyPlane.createDocument();
    await homeRegions.assign(tenant, 'us', 'operator', doc);
    const bob = await nodes['eu']!.client('bob', { [doc]: 'editor' });
    expect((await bob.open(1, doc)).t).toBe('ch.opened');
    expect(roomsOf(c!, 'node-us')).toBe(1);
    expect(roomsOf(c!, 'node-eu')).toBe(0);
  });

  it('fails the channel with unavailable when no node of the home region is live, and writes nothing', async () => {
    const { nodes, homeRegions, tenant, anyPlane } = await regions(['us']);
    await homeRegions.assign(tenant, 'eu', 'operator');
    const doc = await anyPlane.createDocument();
    const before = await c!.mem.head(anyPlane.ref(doc));
    const alice = await nodes['us']!.client('alice', { [doc]: 'editor' });
    const refused = await alice.open(1, doc);
    expect(refused.t).toBe('ch.rejected');
    expect(refused.d).toMatchObject({ code: 'unavailable' });
    expect(roomsOf(c!, 'node-us')).toBe(0);
    // No owner was claimed and no commit was written anywhere.
    expect(await c!.mem.head(anyPlane.ref(doc))).toEqual(before);
    expect(await c!.mem.read(anyPlane.ref(doc), 1)).toEqual([]);
  });

  it('routes as before for a tenant with no home region', async () => {
    const { nodes, anyPlane } = await regions();
    const doc = await anyPlane.createDocument();
    const alice = await nodes['us']!.client('alice', { [doc]: 'editor' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    expect(roomsOf(c!, 'node-eu') + roomsOf(c!, 'node-us')).toBe(1);
  });
});

// BE-074 criterion 3 with decision 233 of docs/owner-decisions-2026-11-26.md: "No cross-region
// read. A gateway routes by region alone, and the receiving node checks the owner" (ADR 0403).
describe('a gateway outside the home region reads nothing of the document (BE-074, decision 233)', () => {
  /** The head reads of a node's log store, by document. */
  function spyOn(mem: Cluster['mem']) {
    const heads: string[] = [];
    const logs = new Proxy(mem, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop === 'head')
          return (ref: { doc: string }) => {
            heads.push(ref.doc);
            return (value as (r: unknown) => unknown).call(target, ref);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { heads, logs };
  }

  it('routes by the region alone: the gateway reads no head, and the home region serves the channel', async () => {
    c = cluster();
    const net = new MemoryBusNetwork(seeded(41));
    const homeRegions = new MemoryHomeRegions();
    const eu = await c.start('node-eu', net.connect('node-eu'), {}, { traits: { region: 'eu' }, homeRegions });
    const spy = spyOn(c.mem);
    const us = await c.start(
      'node-us',
      net.connect('node-us'),
      {},
      { traits: { region: 'us' }, homeRegions, logs: spy.logs },
    );
    await homeRegions.assign(eu.tenant, 'eu', 'operator');
    const doc = await eu.createDocument();
    spy.heads.length = 0;

    const alice = await us.client('alice', { [doc]: 'editor' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    const ack = await alice.submit(1, { base: 0, steps: [insertText(intro(), 'eu ')] });
    expect(ack.d).toMatchObject({ seq: 1 });

    // The room is in the home region, and the gateway's own log store was not asked for the head
    // of the document at any point of the open or the commit.
    expect(roomsOf(c, 'node-eu')).toBe(1);
    expect(roomsOf(c, 'node-us')).toBe(0);
    expect(spy.heads.filter((d) => d === doc)).toEqual([]);
    expect(us.errors).toEqual([]);
    expect(eu.errors).toEqual([]);
  });

  it('follows the node that holds the document when the node it chose is not the owner', async () => {
    c = cluster();
    const net = new MemoryBusNetwork(seeded(42));
    const homeRegions = new MemoryHomeRegions();
    const eu2 = await c.start('node-eu2', net.connect('node-eu2'), {}, { traits: { region: 'eu' }, homeRegions });
    await homeRegions.assign(eu2.tenant, 'eu', 'operator');
    // A document that rendezvous names node-eu1 once both are live, opened while only eu2 is.
    const doc = await docFor(eu2, 'node-eu1', ['node-eu1', 'node-eu2']);
    const first = await eu2.client('bob', { [doc]: 'editor' });
    expect((await first.open(1, doc)).t).toBe('ch.opened');
    expect((await c.mem.head(eu2.ref(doc))).owner).toBe('node-eu2');

    const eu1 = await c.start('node-eu1', net.connect('node-eu1'), {}, { traits: { region: 'eu' }, homeRegions });
    const us = await c.start('node-us', net.connect('node-us'), {}, { traits: { region: 'us' }, homeRegions });
    const alice = await us.client('alice', { [doc]: 'editor' });
    // The gateway chose node-eu1 by region alone; node-eu1 saw the owner and sent it to node-eu2.
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    expect(roomsOf(c, 'node-eu1')).toBe(0);
    expect(roomsOf(c, 'node-us')).toBe(0);
    expect(roomsOf(c, 'node-eu2')).toBe(1);
    const ack = await alice.submit(1, { base: 0, steps: [insertText(intro(), 'moved ')] });
    expect(ack.d).toMatchObject({ seq: 1 });
    expect((await c.mem.head(eu2.ref(doc))).owner).toBe('node-eu2');
    expect(eu1.errors).toEqual([]);
    expect(us.errors).toEqual([]);
  });
});
