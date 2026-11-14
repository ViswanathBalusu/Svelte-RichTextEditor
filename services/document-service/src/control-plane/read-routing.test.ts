// Control-plane reads from read replicas (BE-064). The router is the subject; the primary and the
// replica are in-memory stores whose heads the test controls. PostgreSQL streaming replication is
// not run here (no database), so lag is whatever the test sets.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Metrics } from './metrics.ts';
import { ReadRouter, ReadSession, type ReplicaPort } from './read-routing.ts';

/** A store: the newest sequence number of each document it holds. */
interface Store {
  heads: Map<string, number>;
}

const store = (entries: Record<string, number> = {}): Store => ({
  heads: new Map(Object.entries(entries)),
});

/** A replica port over two stores: applied is the replica's head, primary is the primary's. */
function portFor(primary: Store, replica: Store): ReplicaPort<Store> {
  return {
    store: replica,
    appliedSeq: async (_t, d) => replica.heads.get(d) ?? null,
    primarySeq: async (_t, d) => primary.heads.get(d) ?? null,
  };
}

const head = (doc: string) => async (s: Store) => s.heads.get(doc) ?? null;
const pinned = (doc: string, seq: number) => async (s: Store) =>
  (s.heads.get(doc) ?? -1) >= seq ? seq : null;

describe('a read goes to the replica only when it can answer correctly (BE-064 criteria 1, 2)', () => {
  it('serves from the primary when no replica is configured', async () => {
    const primary = store({ d: 4 });
    const router = new ReadRouter<Store>({ primary });
    const out = await router.read({ kind: 'history', tenant: 't', doc: 'd' }, head('d'));
    expect(out).toEqual({ value: 4, from: 'primary', reason: 'no-replica' });
  });

  it('serves a read from the replica when the replica holds the row', async () => {
    const primary = store({ d: 4 });
    const replica = store({ d: 4 });
    const router = new ReadRouter<Store>({ primary, replica: portFor(primary, replica) });
    const out = await router.read({ kind: 'history', tenant: 't', doc: 'd' }, head('d'));
    expect(out).toEqual({ value: 4, from: 'replica', reason: 'replica' });
  });

  it('answers a pinned read from the primary when the replica has not applied that sequence', async () => {
    const primary = store({ d: 9 });
    const replica = store({ d: 5 });
    const router = new ReadRouter<Store>({ primary, replica: portFor(primary, replica) });
    const out = await router.read(
      { kind: 'pinned', tenant: 't', doc: 'd', seq: 7 },
      pinned('d', 7),
    );
    expect(out).toEqual({ value: 7, from: 'primary', reason: 'behind-pin' });
  });

  it('answers a pinned read from the replica once it has applied the sequence', async () => {
    const primary = store({ d: 9 });
    const replica = store({ d: 8 });
    const router = new ReadRouter<Store>({ primary, replica: portFor(primary, replica) });
    const out = await router.read(
      { kind: 'pinned', tenant: 't', doc: 'd', seq: 7 },
      pinned('d', 7),
    );
    expect(out).toEqual({ value: 7, from: 'replica', reason: 'replica' });
  });

  it('sends a read to the primary when the replica has no row for it, and returns the primary answer', async () => {
    const primary = store({ d: 3 });
    const replica = store({});
    const router = new ReadRouter<Store>({ primary, replica: portFor(primary, replica) });
    const out = await router.read({ kind: 'history', tenant: 't', doc: 'd' }, head('d'));
    expect(out).toEqual({ value: 3, from: 'primary', reason: 'replica-missing' });
  });

  it('answers not found from the primary, not from the replica, for a missing pinned sequence', async () => {
    const primary = store({ d: 2 });
    const replica = store({ d: 2 });
    const router = new ReadRouter<Store>({ primary, replica: portFor(primary, replica) });
    const out = await router.read(
      { kind: 'pinned', tenant: 't', doc: 'd', seq: 5 },
      pinned('d', 5),
    );
    expect(out).toBeNull();
  });

  it('falls back to the primary when the replica read fails', async () => {
    const primary = store({ d: 3 });
    const router = new ReadRouter<Store>({
      primary,
      replica: {
        store: store({ d: 3 }),
        appliedSeq: async () => 3,
        primarySeq: async () => 3,
      },
    });
    const out = await router.read({ kind: 'list', tenant: 't' }, async (s) => {
      if (s === primary) return [...s.heads.keys()];
      throw new Error('replica is down');
    });
    expect(out).toEqual({ value: ['d'], from: 'primary', reason: 'replica-error' });
  });
});

describe('a write followed by a read waits for the replica (BE-064 criterion 3)', () => {
  it('reads from the primary in the same session until the replica reaches the write', async () => {
    const primary = store({ d: 5 });
    const replica = store({ d: 3 });
    const router = new ReadRouter<Store>({ primary, replica: portFor(primary, replica) });
    const session = new ReadSession();
    session.wrote('t', 'd', 5);

    const mine = await router.read({ kind: 'history', tenant: 't', doc: 'd', session }, head('d'));
    expect(mine).toEqual({ value: 5, from: 'primary', reason: 'behind-write' });

    replica.heads.set('d', 5);
    const caughtUp = await router.read(
      { kind: 'history', tenant: 't', doc: 'd', session },
      head('d'),
    );
    expect(caughtUp).toEqual({ value: 5, from: 'replica', reason: 'replica' });
  });

  it('lets another session read the replica, which may still be behind', async () => {
    const primary = store({ d: 5 });
    const replica = store({ d: 3 });
    const router = new ReadRouter<Store>({ primary, replica: portFor(primary, replica) });
    // A session that wrote nothing has no floor: the replica answers, and may be behind the write.
    const other = await router.read(
      { kind: 'history', tenant: 't', doc: 'd', session: new ReadSession() },
      head('d'),
    );
    expect(other).toEqual({ value: 3, from: 'replica', reason: 'replica' });
  });

  it('holds a tenant list back for a document the session wrote, and not for other tenants', async () => {
    const primary = store({ a: 2, b: 7 });
    const replica = store({ a: 1, b: 1 });
    const router = new ReadRouter<Store>({ primary, replica: portFor(primary, replica) });
    const session = new ReadSession();
    session.wrote('t', 'a', 2);
    const listOf = async (s: Store) => [...s.heads.keys()].sort();
    expect(await router.read({ kind: 'list', tenant: 't', session }, listOf)).toEqual({
      value: ['a', 'b'],
      from: 'primary',
      reason: 'behind-write',
    });
    expect(await router.read({ kind: 'list', tenant: 'other', session }, listOf)).toEqual({
      value: ['a', 'b'],
      from: 'replica',
      reason: 'replica',
    });
  });
});

describe('replica lag and route counters are reported (BE-064 criterion 4)', () => {
  it('reports the lag per tenant when metrics are scraped, without document identifiers', async () => {
    const metrics = new Metrics();
    const primary = store({ d1: 10, d2: 4 });
    const replica = store({ d1: 7, d2: 4 });
    const router = new ReadRouter<Store>({
      primary,
      replica: portFor(primary, replica),
      metrics,
    });
    expect(await router.observeLag('tenant-x', 'd1')).toBe(3);
    expect(await router.observeLag('tenant-x', 'd2')).toBe(0);
    const text = await metrics.render();
    expect(text).toContain('# TYPE docedit_replica_lag_seq gauge');
    expect(text).toContain('docedit_replica_lag_seq{tenant="tenant-x"} 3');
    expect(text).not.toContain('d1');
  });

  it('counts the reads each store answered and why', async () => {
    const metrics = new Metrics();
    const primary = store({ d: 9 });
    const replica = store({ d: 5 });
    const router = new ReadRouter<Store>({
      primary,
      replica: portFor(primary, replica),
      metrics,
    });
    await router.read({ kind: 'pinned', tenant: 't', doc: 'd', seq: 7 }, pinned('d', 7));
    await router.read({ kind: 'pinned', tenant: 't', doc: 'd', seq: 4 }, pinned('d', 4));
    expect(
      metrics.value('docedit_read_route_total', { route: 'primary', reason: 'behind-pin' }),
    ).toBe(1);
    expect(metrics.value('docedit_read_route_total', { route: 'replica', reason: 'replica' })).toBe(
      1,
    );
  });
});

describe('reads are correct under any order of writes, catch-up and reads (BE-064; property)', () => {
  type Op =
    | { op: 'write'; doc: 'a' | 'b'; session: 0 | 1 }
    | { op: 'catchUp'; doc: 'a' | 'b'; by: number }
    | { op: 'head'; doc: 'a' | 'b'; session: 0 | 1 }
    | { op: 'pinned'; doc: 'a' | 'b'; seq: number; session: 0 | 1 };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      op: fc.constant('write' as const),
      doc: fc.constantFrom('a' as const, 'b' as const),
      session: fc.constantFrom(0 as const, 1 as const),
    }),
    fc.record({
      op: fc.constant('catchUp' as const),
      doc: fc.constantFrom('a' as const, 'b' as const),
      by: fc.integer({ min: 1, max: 3 }),
    }),
    fc.record({
      op: fc.constant('head' as const),
      doc: fc.constantFrom('a' as const, 'b' as const),
      session: fc.constantFrom(0 as const, 1 as const),
    }),
    fc.record({
      op: fc.constant('pinned' as const),
      doc: fc.constantFrom('a' as const, 'b' as const),
      seq: fc.integer({ min: 1, max: 8 }),
      session: fc.constantFrom(0 as const, 1 as const),
    }),
  );

  it('never returns a value older than the session wrote, and a pinned value is the sequence asked for', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 60 }), async (ops) => {
        const primary = store();
        const replica = store();
        const router = new ReadRouter<Store>({ primary, replica: portFor(primary, replica) });
        const sessions = [new ReadSession(), new ReadSession()] as const;
        for (const o of ops) {
          if (o.op === 'write') {
            const next = (primary.heads.get(o.doc) ?? 0) + 1;
            primary.heads.set(o.doc, next);
            sessions[o.session].wrote('t', o.doc, next);
          } else if (o.op === 'catchUp') {
            const applied = replica.heads.get(o.doc) ?? 0;
            const target = Math.min(primary.heads.get(o.doc) ?? 0, applied + o.by);
            if (target > 0) replica.heads.set(o.doc, target);
          } else if (o.op === 'head') {
            const floor = Math.max(
              0,
              ...sessions[o.session].writesIn('t', o.doc).map((w) => w.seq),
            );
            const out = await router.read(
              { kind: 'history', tenant: 't', doc: o.doc, session: sessions[o.session] },
              head(o.doc),
            );
            if (primary.heads.get(o.doc) === undefined) {
              expect(out).toBeNull();
            } else {
              expect(out).not.toBeNull();
            }
            if (out) {
              expect(out.value).toBeGreaterThanOrEqual(floor);
              expect(out.value).toBeLessThanOrEqual(primary.heads.get(o.doc) ?? 0);
              if (out.from === 'primary') expect(out.value).toBe(primary.heads.get(o.doc));
            }
          } else {
            const head = primary.heads.get(o.doc) ?? -1;
            const out = await router.read(
              { kind: 'pinned', tenant: 't', doc: o.doc, seq: o.seq, session: sessions[o.session] },
              pinned(o.doc, o.seq),
            );
            if (head < o.seq) {
              expect(out).toBeNull();
            } else {
              expect(out?.value).toBe(o.seq);
              if (out?.from === 'replica')
                expect((replica.heads.get(o.doc) ?? -1) >= o.seq).toBe(true);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
