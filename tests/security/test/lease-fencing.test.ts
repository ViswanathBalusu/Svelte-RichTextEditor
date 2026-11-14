/**
 * SEC-031 criteria 2 and 4 (10 §3.3; 06 §2.1, §8; BE-018): a node whose lease cannot be proved stops
 * serving, viewers included, and a moved system clock neither extends the lease nor shortens it.
 *
 * The lease is shortened by the harness (durationMs 1.2 s, renewMs 0.2 s, marginMs 0.1 s), so the
 * cases take about a second each. The node proves its lease with its own monotonic clock; the
 * database judges expiry by its own clock. The database clock here is real time that the test
 * cannot move through `Date.now`, so the only clock the test moves is the node's wall clock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryNodeLeases } from '../../../services/document-service/src/data-plane/memory-ports.ts';
import { documentWithRegions, startHarness, type Harness } from './support/harness.ts';
import { WireClient } from './support/wire.ts';

/** The lease the harness gives this node: short, so that a loss takes about a second. */
const LEASE = { durationMs: 1200, renewMs: 200, marginMs: 100 };

/** The node's lease store, whose renewals a test can make fail (an unreachable database). */
const failing = (h: Harness): { failing: boolean } =>
  h.parts.leases as unknown as { failing: boolean };

/** The node lease, through the data plane (BE-018). */
interface LeaseView {
  readonly proven: boolean;
  readonly stats: { lost: number; renewed: number };
}
const leaseOf = (h: Harness): LeaseView =>
  (h.service.dataPlane as unknown as { lease: LeaseView }).lease;

/** Resolves once the node has taken its lease, as a node does before it serves (BE-018). */
async function leaseTaken(h: Harness): Promise<void> {
  const ready = (h.service.dataPlane as unknown as { ready(): Promise<boolean> }).ready();
  expect(await ready).toBe(true);
}

/** Waits for the lease check to see the loss, and the channel to close with `unavailable`. */
async function closesUnavailable(c: WireClient): Promise<void> {
  const closed = await c.take((m) => m.t === 'ch.closed', 5000, 'the viewer channel closing');
  expect(closed.d?.['code']).toBe('unavailable');
}

const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
  vi.restoreAllMocks();
});

describe('SEC-031 a node that cannot prove its lease stops serving, viewers included', () => {
  it('disconnects a viewers-only room and refuses new channels once its lease is lost', async () => {
    const h = await startHarness('memory', { node: 'node-A', dataPlane: { lease: LEASE } });
    harnesses.push(h);
    await leaseTaken(h);

    const doc = await h.createDocument(h.a, documentWithRegions());
    // A room with only viewers: the case the lease exists for, since no writer would notice.
    const token = await h.mintToken(h.a, 'vee', { [doc]: 'viewer' });
    const v = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    await v.hello(token);
    expect((await v.open(1, doc)).t).toBe('ch.opened');
    expect(leaseOf(h).proven).toBe(true);

    // The database becomes unreachable: renewals fail and the lease runs out on the node's clock.
    failing(h).failing = true;
    await closesUnavailable(v);
    expect(leaseOf(h).proven).toBe(false);
    expect(leaseOf(h).stats.lost).toBeGreaterThanOrEqual(1);

    // The node serves nothing new while the lease is unproved: a second viewer is refused.
    const w = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    await w.hello(token).catch(() => null);
    const late = await w.open(1, doc).catch(() => null);
    expect(late?.t).not.toBe('ch.opened');
    v.terminate();
    w.terminate();
  }, 20_000);
});

describe('SEC-031 a moved system clock neither extends nor shortens the lease', () => {
  it('is judged by the database clock and the monotonic clock, not by the wall clock', async () => {
    // The database clock is real time measured from a point the test cannot move: the wall clock
    // (Date.now) is what the test moves, and it must not change the outcome.
    const t0 = Date.now();
    const p0 = performance.now();
    const dbNow = () => t0 + (performance.now() - p0);
    const leases = new MemoryNodeLeases(dbNow);
    const h = await startHarness('memory', {
      node: 'node-A',
      parts: { leases },
      dataPlane: { lease: LEASE },
    });
    harnesses.push(h);
    await leaseTaken(h);

    // Authenticate and open before the clock moves: tokens are checked against the wall clock.
    const doc = await h.createDocument(h.a, documentWithRegions());
    const token = await h.mintToken(h.a, 'vee', { [doc]: 'viewer' });
    const v = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    await v.hello(token);
    expect((await v.open(1, doc)).t).toBe('ch.opened');

    // The system clock jumps forward by an hour. Renewals still succeed (the database clock is
    // unchanged), so the lease is kept and the viewer stays connected.
    const realNow = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow + 3_600_000);
    await new Promise((r) => setTimeout(r, 700));
    expect(leaseOf(h).proven).toBe(true);
    expect(v.closeInfo).toBeNull();

    // Renewals now fail, and the system clock is set an hour back. Were the lease judged by the
    // wall clock, the back-step would extend it by an hour and the viewer would stay connected.
    failing(h).failing = true;
    spy.mockImplementation(() => realNow - 3_600_000);
    await closesUnavailable(v);
    expect(leaseOf(h).proven).toBe(false);
    spy.mockRestore();
    v.terminate();
  }, 20_000);
});
