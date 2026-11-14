/**
 * Channel closes carry a code and a reason (PRO-024 criterion 2; 05 §5.2). The server sends
 * `ch.closed` with `code`, `reason` and, when it applies, `retryInMs`: `forbidden` after a
 * revocation, `unavailable` when the room stops, and `slow_consumer` when the client cannot keep
 * up. The real data plane runs over the in-memory stores (test/data-plane/support.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

type Settings = NonNullable<Parameters<typeof startPlane>[0]>['settings'];

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function plane(settings?: Settings): Promise<Plane> {
  const p = await startPlane(settings === undefined ? {} : { settings });
  planes.push(p);
  return p;
}

/** The reason is a non-empty string; `retryInMs`, when present, is a positive number. */
function expectReason(d: Record<string, unknown> | undefined): void {
  expect(typeof d?.['reason']).toBe('string');
  expect((d!['reason'] as string).length).toBeGreaterThan(0);
  if ('retryInMs' in d!) expect(d['retryInMs']).toBeGreaterThan(0);
}

describe('ch.closed carries a code and a reason (PRO-024 criterion 2)', () => {
  it('closes a revoked user channel with forbidden and a reason, and no retry hint', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const bob = await p.client('bob', { [doc]: 'editor' });
    expect((await bob.open(1, doc)).t).toBe('ch.opened');
    p.plane.sessionsRevoked(p.tenant, 'bob', doc);
    const closed = await bob.take((m) => m.t === 'ch.closed');
    expect(closed.d).toMatchObject({ code: 'forbidden' });
    expectReason(closed.d);
    // Access is gone, not temporarily unavailable: no retry is promised.
    expect(closed.d).not.toHaveProperty('retryInMs');
  });

  it('closes a channel of a room that stops with unavailable and a reason', async () => {
    const p = await plane({ testMode: true });
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    expect((await a.open(1, doc)).t).toBe('ch.opened');
    expect(await p.plane.hooks!.killRoom(p.ref(doc))).toBe(true);
    const closed = await a.take((m) => m.t === 'ch.closed');
    expect(closed.d).toMatchObject({ code: 'unavailable' });
    expectReason(closed.d);
    expect(a.closeInfo).toBeNull();
  });

  it('closes the channels of a room another node fences with unavailable and a reason', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    // Node B claims the document; the room on node A is fenced and stops (BE-017).
    const q = await startPlane({ stores: p.stores, checkpoints: p.checkpoints, tenant: p.tenant });
    planes.push(q);
    const b = await q.client('carol', { [doc]: 'editor' });
    await b.open(1, doc);
    // A's next write is fenced by the new epoch, and the room then closes its channels.
    a.submitNoWait(1, { base: 0, steps: [insertText(intro(), 'fenced text')] });
    const closed = await a.take((m) => m.t === 'ch.closed');
    expect(closed.d).toMatchObject({ code: 'unavailable' });
    expectReason(closed.d);
    // retryInMs is optional (05 §5.2): the fenced write does not send one, and that is accepted.
    expect(closed.d).not.toHaveProperty('retryInMs');
  });

  it('closes a channel that falls behind with slow_consumer and a reason', async () => {
    const p = await plane({ sendQueueBytes: 256 * 1024, socketHighWater: 32 * 1024 });
    const doc = await p.createDocument();
    const writer = await p.client('alice', { [doc]: 'owner' });
    const slow = await p.client('carol', { [doc]: 'editor' });
    await writer.open(1, doc);
    expect((await slow.open(1, doc)).t).toBe('ch.opened');
    slow.ws.pause();
    const text = 'x'.repeat(60_000);
    let head = 0;
    for (let i = 0; i < 160 && !slow.closeInfo; i++) {
      const r = await writer.submit(1, { base: head, steps: [insertText(intro(), text)] });
      expect(r.t).toBe('sync.ack');
      head = r.d!['seq'];
      if (p.plane.metricsRegistry.slowConsumers.get({ tenant: p.tenant }) > 0) break;
    }
    slow.ws.resume();
    const closed = await slow.take((m) => m.t === 'ch.closed' && m.ch === 1, 15_000);
    expect(closed.d).toMatchObject({ code: 'slow_consumer' });
    expectReason(closed.d);
  }, 60_000);
});
