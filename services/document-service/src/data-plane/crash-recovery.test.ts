/**
 * Recovery after a room host crash (BE-076; 06 §8, first row; 04 §9).
 *
 * A crash is modelled as the test hook `killRoom` (BE-079): the room stops at once, with no
 * checkpoint and no release of ownership, which is what a killed process leaves behind. The second
 * plane is a new node over the same stores, so it sees only what the first one made durable: the
 * log, the head, the ownership row, the checkpoints and the node leases. Each plane has its own
 * token registry (as a restarted process would), so the client reconnects with a fresh `hello`.
 *
 * The planes are not closed until the end of each test. `plane.close()` checkpoints and releases
 * ownership, which a crash does not do, so closing the crashed plane first would change the state
 * the test is about.
 *
 * Criterion 5 (the fifteen-minute recovery time, hosted mode) is a measurement of a deployment and
 * is not tested here. The PostgreSQL side of the same crash needs a database and is not run here.
 */
import { uuid7 } from '@docedit/model';
import * as fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import {
  GatedLogStore,
  MemoryCheckpoints,
  startPlane,
  until,
  type Plane,
  type Stores,
} from '../../test/data-plane/support.ts';
import { MemoryStore } from '../storage/memory.ts';
import type { DocRef, LogStore, NodeLeaseStore } from '../storage/types.ts';
import { MemoryNodeLeases } from './memory-ports.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

/** What survives a crash: the durable stores and the checkpoints, shared by every node. */
interface Durable {
  tenant: string;
  memory: MemoryStore;
  checkpoints: MemoryCheckpoints;
  /** The deployment's view key (DOCEDIT_VIEW_KEY), the same on every node. */
  viewKey: Uint8Array;
}

function durable(): Durable {
  return {
    tenant: crypto.randomUUID(),
    memory: new MemoryStore(),
    checkpoints: new MemoryCheckpoints(),
    viewKey: crypto.getRandomValues(new Uint8Array(32)),
  };
}

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** A node over the durable state. `logs` can wrap the log store to hold or fail writes. */
async function boot(
  d: Durable,
  node: string,
  o: { logs?: LogStore; leases?: NodeLeaseStore } = {},
): Promise<Plane> {
  const stores: Stores = {
    logs: o.logs ?? d.memory,
    ownership: d.memory,
    grants: d.memory,
    documents: d.memory,
  };
  const p = await startPlane({
    stores,
    checkpoints: d.checkpoints,
    tenant: d.tenant,
    node,
    settings: { testMode: true, viewKey: d.viewKey },
    deps: o.leases ? { leases: o.leases } : {},
  });
  planes.push(p);
  return p;
}

/** Node leases whose renewals of a crashed node stop, as a dead process's would. */
class CrashableLeases extends MemoryNodeLeases {
  readonly crashed = new Set<string>();
  override async renew(node: string, leaseMs: number): Promise<void> {
    if (this.crashed.has(node)) return;
    return super.renew(node, leaseMs);
  }
}

/** Commit identifiers in the stored log, in `seq` order. */
async function storedIds(d: Durable, ref: DocRef): Promise<string[]> {
  return (await d.memory.read(ref)).map((c) => c.id);
}

describe('recovery after a room host crash (BE-076)', () => {
  it('keeps an acknowledged commit: after the crash and a restart, the reconnecting client finds it in the log and in the content at the head', async () => {
    const d = durable();
    const a = await boot(d, 'node-a');
    const doc = await a.createDocument();
    const ref = a.ref(doc);
    const alice = await a.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = uuid7();
      ids.push(id);
      const r = await alice.submit(1, { id, base: i, steps: [insertText(intro(), `t${i}`)] });
      expect(r.t).toBe('sync.ack');
      expect(r.d).toMatchObject({ id, seq: i + 1 });
    }

    // The process is killed with no warning: no checkpoint, no release of ownership.
    expect(await a.plane.hooks!.killRoom(ref)).toBe(true);
    expect((await d.memory.head(ref)).owner).toBe('node-a');

    // A new process on the same storage; the client reconnects with a new hello.
    const b = await boot(d, 'node-b');
    const bob = await b.client('alice', { [doc]: 'owner' });
    const opened = await bob.open(1, doc);
    expect(opened.t).toBe('ch.opened');
    expect(opened.d).toMatchObject({ head: 3 });

    expect(await storedIds(d, ref)).toEqual(ids);
    const content = await b.plane.readContent(b.tokens.identity(bob.token!), doc);
    expect(content.seq).toBe(3);
    expect((await d.memory.head(ref)).owner).toBe('node-b');
  });

  it('a commit in flight at the kill: a client that resumes with inflight learns whether it was stored, and its resubmission is stored once', async () => {
    for (const storedBeforeKill of [false, true]) {
      const d = durable();
      const gate = new GatedLogStore(d.memory);
      const a = await boot(d, 'node-a', { logs: gate });
      const doc = await a.createDocument();
      const ref = a.ref(doc);
      const alice = await a.client('alice', { [doc]: 'owner' });
      const first = await alice.open(1, doc);
      const incarnation = first.d!['incarnation'] as string;
      const view = first.d!['view'];
      const firstId = uuid7();
      expect(
        (await alice.submit(1, { id: firstId, base: 0, steps: [insertText(intro(), 'one')] })).t,
      ).toBe('sync.ack');

      // Held inside the persist step: the write has been sent and not answered.
      const inflight = uuid7();
      gate.hold = true;
      alice.submitNoWait(1, { id: inflight, base: 1, steps: [insertText(intro(), 'two')] });
      await until(() => gate.pending === 1, 3000, 'the write held in flight');
      // Either the write never reached the store, or it was stored and the answer was lost.
      if (storedBeforeKill) await gate.release();
      expect(await a.plane.hooks!.killRoom(ref)).toBe(true);
      expect(await storedIds(d, ref)).toEqual(storedBeforeKill ? [firstId, inflight] : [firstId]);

      const b = await boot(d, 'node-b');
      const bob = await b.client('alice', { [doc]: 'owner' });
      const o = await bob.open(1, doc, {
        resume: { seq: 1, incarnation, view, inflight },
      });
      expect(o.t).toBe('ch.opened');
      expect(o.d!['inflight']).toEqual(
        storedBeforeKill ? { state: 'accepted', seq: 2 } : { state: 'unknown' },
      );
      // The client sent the view token it was given, so the new node streams what the client
      // missed and then says `sync.caughtUp`.
      expect(o.d!['catchUp']).toBe('stream');
      const caught = await bob.take((m) => m.t === 'sync.caughtUp');
      expect(caught.d).toMatchObject({ seq: storedBeforeKill ? 2 : 1 });
      const streamed = bob
        .all('sync.commit', 1)
        .flatMap((m) => m.d!['commits'] as Array<{ id: string }>)
        .map((c) => c.id);
      expect(streamed).toEqual(storedBeforeKill ? [inflight] : []);

      // After sync.caughtUp the client resubmits the same commit; it is stored once, whatever the
      // answer was.
      const r = await bob.submit(1, { id: inflight, base: 1, steps: [insertText(intro(), 'two')] });
      expect(r.t).toBe('sync.ack');
      expect(r.d).toMatchObject({ id: inflight, seq: 2 });
      expect(await storedIds(d, ref)).toEqual([firstId, inflight]);
      // Resubmitting it again still changes nothing.
      const again = await bob.submit(1, {
        id: inflight,
        base: 1,
        steps: [insertText(intro(), 'two')],
      });
      expect(again.d).toMatchObject({ id: inflight, seq: 2 });
      expect(await storedIds(d, ref)).toEqual([firstId, inflight]);
    }
  }, 30_000);

  it('a dead node keeps its documents until its lease expires by the database clock; then a new process opens them from storage and serves clients again', async () => {
    const clock = { now: 1_700_000_000_000 };
    const leases = new CrashableLeases(() => clock.now);
    const d = durable();
    const a = await boot(d, 'node-a', { leases });
    expect(await a.plane.ready()).toBe(true);
    const doc = await a.createDocument();
    const ref = a.ref(doc);
    const alice = await a.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    for (let i = 0; i < 2; i++)
      expect((await alice.submit(1, { base: i, steps: [insertText(intro(), `a${i}`)] })).t).toBe(
        'sync.ack',
      );

    // Node A crashes: its renewals stop and its room stops with no release.
    leases.crashed.add('node-a');
    expect(await a.plane.hooks!.killRoom(ref)).toBe(true);

    const b = await boot(d, 'node-b', { leases });
    expect(await b.plane.ready()).toBe(true);
    const bob = await b.client('alice', { [doc]: 'owner' });
    // While A's lease is still good by the database clock, B may not take the document.
    const early = await bob.open(1, doc);
    expect(early.t).toBe('ch.rejected');
    expect(early.d).toMatchObject({ code: 'unavailable' });
    expect(await leases.alive('node-a')).toBe(true);

    // The lease runs out by the database clock; the node's own clock is not consulted.
    clock.now += 3_001;
    expect(await leases.alive('node-a')).toBe(false);

    const opened = await bob.open(1, doc);
    expect(opened.t).toBe('ch.opened');
    expect(opened.d).toMatchObject({ head: 2 });
    expect((await d.memory.head(ref)).owner).toBe('node-b');
    expect((await b.plane.readContent(b.tokens.identity(bob.token!), doc)).seq).toBe(2);

    const next = await bob.submit(1, { base: 2, steps: [insertText(intro(), 'b')] });
    expect(next.t).toBe('sync.ack');
    expect(next.d).toMatchObject({ seq: 3 });
    expect((await d.memory.read(ref)).map((c) => c.seq)).toEqual([1, 2, 3]);
  });

  it('kills at random points of the persist pipeline, over many runs: no confirmed seq is above the log head, and each commit is stored exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3 }),
        fc.constantFrom<'before-store' | 'after-store'>('before-store', 'after-store'),
        async (before, point) => {
          const d = durable();
          const gate = new GatedLogStore(d.memory);
          const a = await boot(d, 'node-a', { logs: gate });
          const doc = await a.createDocument();
          const ref = a.ref(doc);
          const alice = await a.client('alice', { [doc]: 'owner' });
          const opened = await alice.open(1, doc);
          const incarnation = opened.d!['incarnation'] as string;

          // Confirmed commits: the client holds their sequence numbers.
          const confirmed: number[] = [];
          const sent: string[] = [];
          for (let i = 0; i < before; i++) {
            const id = uuid7();
            sent.push(id);
            const r = await alice.submit(1, { id, base: i, steps: [insertText(intro(), `c${i}`)] });
            expect(r.t).toBe('sync.ack');
            confirmed.push(r.d!['seq'] as number);
          }

          const inflight = uuid7();
          sent.push(inflight);
          gate.hold = true;
          alice.submitNoWait(1, { id: inflight, base: before, steps: [insertText(intro(), 'x')] });
          await until(() => gate.pending === 1, 3000, 'the write held in flight');
          if (point === 'after-store') await gate.release();
          await a.plane.hooks!.killRoom(ref);

          const b = await boot(d, 'node-b');
          const bob = await b.client('alice', { [doc]: 'owner' });
          const resumed = await bob.open(1, doc, {
            resume: { seq: Math.max(0, ...confirmed), incarnation, inflight },
          });
          expect(resumed.t).toBe('ch.opened');
          const head = resumed.d!['head'] as number;
          // No confirmed sequence number is above what the log holds.
          for (const seq of confirmed) expect(seq).toBeLessThanOrEqual(head);

          // The client resubmits everything it had not seen confirmed; duplicates are answered.
          const r = await bob.submit(1, {
            id: inflight,
            base: before,
            steps: [insertText(intro(), 'x')],
          });
          expect(r.t).toBe('sync.ack');

          const stored = await d.memory.read(ref);
          expect(stored.map((c) => c.seq)).toEqual(stored.map((_, i) => i + 1));
          expect(stored.map((c) => c.id).sort()).toEqual([...sent].sort());
          expect(new Set(stored.map((c) => c.id)).size).toBe(sent.length);
        },
      ),
      { numRuns: 12 },
    );
  }, 120_000);
});
