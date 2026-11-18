// Routing a document to one owning node (BE-060). The routing runs over the node lease store: the
// live hosts are the nodes that hold a lease that has not expired by the database clock. Criteria
// 1 and 2 use that store with its own clock; criterion 3 runs two data planes over one set of
// stores and shows that the epoch check, not the routing, decides who owns a document.
import { afterEach, describe, expect, it } from 'vitest';
import { Placement, routeDocument } from '../../src/control-plane/room-routing.ts';
import { MemoryNodeLeases } from '../../src/data-plane/memory-ports.ts';
import { MemoryStore } from '../../src/storage/memory.ts';
import { MemoryCheckpoints, startPlane, type Plane } from './support.ts';

const DOCS = Array.from({ length: 300 }, (_, i) => `doc-${i}-${(i * 7919).toString(36)}`);

describe('a document is routed over the nodes that hold a live lease (BE-060 criterion 1)', () => {
  it('names the host that rendezvous hashing picks over the live set, and no expired host', async () => {
    let clock = 1000;
    const leases = new MemoryNodeLeases(() => clock);
    await leases.renew('node-a', 5000, 'ws://a/dep');
    await leases.renew('node-b', 5000, 'ws://b/dep');
    await leases.renew('node-c', 1000, 'ws://c/dep');
    const placement = new Placement(leases);
    for (const doc of DOCS) {
      const named = await placement.route(doc);
      expect(named?.node).toBe(routeDocument(doc, ['node-a', 'node-b', 'node-c']));
      expect(named?.address).toBe(`ws://${named!.node.slice(-1)}/dep`);
    }
    // node-c's lease runs out by the database clock: it is no longer named.
    clock = 2500;
    const named = new Set<string>();
    for (const doc of DOCS) named.add((await placement.route(doc))!.node);
    expect([...named].sort()).toEqual(['node-a', 'node-b']);
  });

  it('names no host when no lease is live', async () => {
    const leases = new MemoryNodeLeases(() => 0);
    expect(await new Placement(leases).route('d')).toBeNull();
    await leases.renew('node-a', 10);
    await leases.release('node-a');
    expect(await new Placement(leases).route('d')).toBeNull();
  });
});

describe('a host joining or leaving moves only the documents that hash to it (BE-060 criterion 2)', () => {
  const owners = async (placement: Placement) =>
    new Map(
      await Promise.all(DOCS.map(async (d) => [d, (await placement.route(d))!.node] as const)),
    );

  it('moves a document on a join only to the joining host', async () => {
    const leases = new MemoryNodeLeases(() => 0);
    for (const n of ['node-a', 'node-b', 'node-c']) await leases.renew(n, 10_000);
    const placement = new Placement(leases);
    const before = await owners(placement);
    await leases.renew('node-d', 10_000);
    const after = await owners(placement);
    let moved = 0;
    for (const d of DOCS) {
      if (after.get(d) !== before.get(d)) {
        moved++;
        expect(after.get(d)).toBe('node-d');
      }
    }
    // Roughly a quarter of the documents move; a join must not move all of them.
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(DOCS.length / 2);
  });

  it('moves a document on a leave only when the leaving host owned it', async () => {
    const leases = new MemoryNodeLeases(() => 0);
    for (const n of ['node-a', 'node-b', 'node-c', 'node-d']) await leases.renew(n, 10_000);
    const placement = new Placement(leases);
    const before = await owners(placement);
    await leases.release('node-b');
    const after = await owners(placement);
    let moved = 0;
    for (const d of DOCS) {
      if (before.get(d) === 'node-b') {
        moved++;
        expect(after.get(d)).not.toBe('node-b');
      } else expect(after.get(d)).toBe(before.get(d));
    }
    expect(moved).toBeGreaterThan(0);
  });
});

describe('routing never grants ownership (BE-060 criterion 3)', () => {
  let planes: Plane[] = [];
  afterEach(async () => {
    for (const p of planes) await p.close();
    planes = [];
  });

  it('leaves a document with the node that holds its epoch while that node lives, and hands it over by the epoch when the lease ends', async () => {
    const mem = new MemoryStore();
    const leases = new MemoryNodeLeases();
    const checkpoints = new MemoryCheckpoints();
    const tenant = crypto.randomUUID();
    const start = async (node: string) => {
      const p = await startPlane({
        stores: { logs: mem, ownership: mem, grants: mem, documents: mem },
        checkpoints,
        tenant,
        node,
        deps: { leases, address: `ws://${node}/dep` },
        settings: { lease: { durationMs: 800, renewMs: 100, marginMs: 100 } },
      });
      planes.push(p);
      expect(await p.plane.ready()).toBe(true);
      return p;
    };
    const a = await start('node-a');
    const b = await start('node-b');
    const placement = new Placement(leases);

    // A document that routing names node-a for, opened first on node-b.
    let doc = await b.createDocument();
    for (let i = 0; i < 40 && (await placement.route(doc))?.node !== 'node-a'; i++)
      doc = await b.createDocument();
    expect((await placement.route(doc))?.node).toBe('node-a');
    const onB = await b.client('alice', { [doc]: 'editor' });
    expect((await onB.open(1, doc)).t).toBe('ch.opened');
    const held = await mem.head(b.ref(doc));
    expect(held.owner).toBe('node-b');

    // Routing names node-a, and node-a does not take the document: node-b's epoch stands.
    const onA = await a.client('bob', { [doc]: 'editor' });
    const refused = await onA.open(1, doc);
    expect(refused.t).toBe('ch.rejected');
    expect(refused.d).toMatchObject({ code: 'unavailable' });
    const still = await mem.head(b.ref(doc));
    expect(still.owner).toBe('node-b');
    expect(still.epoch).toBe(held.epoch);

    // node-b stops renewing and its lease runs out; the epoch check now lets node-a win.
    await b.plane.lease!.stop(false);
    for (let i = 0; i < 200 && (await leases.alive('node-b')); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(await leases.alive('node-b')).toBe(false);
    const later = await a.client('bob', { [doc]: 'editor' });
    expect((await later.open(1, doc)).t).toBe('ch.opened');
    const taken = await mem.head(a.ref(doc));
    expect(taken.owner).toBe('node-a');
    expect(taken.epoch).toBe(held.epoch + 1);
  });
});
