/**
 * BE-027 criterion 3: when one channel is slow and is closed, the other channels in the room keep
 * their latency and the room's memory returns to its baseline (06 §2.4, §8).
 *
 * Latency is the time from a writer sending a commit to a second, fast reader receiving it. It is
 * taken in two phases over the same room and the same commit size: first with no slow reader, then
 * with a reader whose socket is paused (so its queue grows) until the service closes it with
 * `slow_consumer`. The fast reader must receive every commit in order in both phases, and its median
 * latency in the slow phase must stay within a loose allowance of the first phase's. The allowance
 * is this test's own (the spec gives no figure; it is there to catch a fast reader that waits for
 * the slow one, which would be many times slower), not a target. The medians of the run are in the
 * assertion messages.
 *
 * Memory is the send-queue memory the slow channel added: the bytes queued over all connections
 * (`dep_send_queue_bytes` and the sessions' own counters) are read before the slow reader joins and
 * again once it is closed and the writer's acknowledgements have drained; they must be equal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from './client.ts';
import { startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('closing a slow consumer leaves the other channels alone (BE-027 criterion 3)', () => {
  it('keeps the fast reader in order and at its latency, and returns the queued bytes to the baseline', async () => {
    const p = await startPlane({
      settings: { sendQueueBytes: 256 * 1024, socketHighWater: 32 * 1024 },
    });
    planes.push(p);
    const doc = await p.createDocument();
    const writer = await p.client('alice', { [doc]: 'owner' });
    const fast = await p.client('dave', { [doc]: 'viewer' });
    await writer.open(1, doc);
    await fast.open(1, doc);

    // When each commit reached the fast reader, by seq.
    const arrived = new Map<number, number>();
    fast.onMessage = (m) => {
      if (m.t !== 'sync.commit' || m.ch !== 1) return;
      for (const c of m.d!['commits'] as Array<{ seq: number }>)
        arrived.set(c.seq, performance.now());
    };
    const text = 'x'.repeat(60_000);
    let head = 0;
    const latencies: number[] = [];
    const write = async (): Promise<void> => {
      const sent = performance.now();
      const r = await writer.submit(1, { base: head, steps: [insertText(intro(), text)] });
      expect(r.t).toBe('sync.ack');
      head = r.d!['seq'];
      await until(() => arrived.has(head), 10_000, `commit ${head} at the fast reader`);
      latencies.push(arrived.get(head)! - sent);
    };
    const queued = () => p.plane.sessions.reduce((a, s) => a + s.queuedBytes, 0);

    // Phase 1: no slow reader.
    for (let i = 0; i < 10; i++) await write();
    const baselineLatency = median(latencies.splice(0));
    await until(() => queued() === 0, 5000, 'the send queues to drain');
    const baselineQueued = queued();

    // Phase 2: a reader that does not read, until the service closes it.
    const slow = await p.client('carol', { [doc]: 'editor' });
    await slow.open(1, doc);
    slow.ws.pause();
    for (let i = 0; i < 160; i++) {
      await write();
      if (p.plane.metricsRegistry.slowConsumers.get({ tenant: p.tenant }) > 0) break;
    }
    expect(p.plane.metricsRegistry.slowConsumers.get({ tenant: p.tenant })).toBe(1);
    const slowLatency = median(latencies.splice(0));
    slow.ws.resume();
    await slow.take((m) => m.t === 'ch.closed' && m.ch === 1, 15_000);

    // The fast reader saw every commit, once and in order, and was not closed.
    const seqs = fast
      .all('sync.commit', 1)
      .flatMap((m) => (m.d!['commits'] as Array<{ seq: number }>).map((c) => c.seq));
    expect(seqs).toEqual(Array.from({ length: head }, (_, i) => i + 1));
    expect(fast.all('ch.closed')).toHaveLength(0);

    // Its latency stayed in the range of the first phase.
    const allowance = Math.max(5 * baselineLatency, baselineLatency + 50);
    expect(
      slowLatency,
      `median latency with a slow reader ${slowLatency.toFixed(1)} ms, without ${baselineLatency.toFixed(1)} ms`,
    ).toBeLessThanOrEqual(allowance);

    // The memory the slow channel's queue held is back to what it was before the channel joined.
    await until(() => queued() === baselineQueued, 5000, 'the send queues to return to baseline');
    expect(queued()).toBe(baselineQueued);
    expect(p.plane.metrics()).toMatch(
      new RegExp(
        `^dep_send_queue_bytes\\{[^}]*tenant="${p.tenant}"[^}]*\\} ${baselineQueued}$`,
        'm',
      ),
    );
  }, 60_000);
});
