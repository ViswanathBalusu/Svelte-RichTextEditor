// BE-055 criterion 2 (05 section 7; lane w5): a commit stored by a room raises
// `dep.document.changed.v1` with `seq` and the hash-chain head, and the sink in front of the
// dispatcher raises at most one per document per 10 seconds. The room is the real one (in-memory
// log store), the edits come over a WebSocket client, and the clock is a fake that the test moves.
// The dispatcher's send path is tested in webhook-dispatcher.test.ts and webhook-egress.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { MemoryEventSink } from '../../src/control-plane/events.ts';
import { CHANGE_WINDOW_MS, DebouncedEventSink } from '../../src/control-plane/event-throttle.ts';
import { insertText } from './client.ts';
import { startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

describe('a stored commit raises dep.document.changed (BE-055 criterion 2)', () => {
  let plane: Plane;
  let clock = Date.now();
  const raised = new MemoryEventSink();
  const sink = new DebouncedEventSink(raised, () => clock);

  beforeAll(async () => {
    plane = await startPlane({ now: () => clock, deps: { events: sink } });
  });

  afterAll(async () => {
    sink.close();
    await plane?.close().catch(() => {});
  });

  it('raises the first change at once with seq and the chain head, holds the rest of a burst for the window, then raises the last', async () => {
    const doc = await plane.createDocument();
    const ref = plane.ref(doc);
    const alice = await plane.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    const changed = () => raised.of('dep.document.changed.v1');

    const first = await alice.submit(1, { base: 0, steps: [insertText(intro(), 'one')] });
    expect(first.t).toBe('sync.ack');
    await until(() => changed().length === 1, 3000, 'the first change event');
    const head1 = await plane.stores.logs.state!(ref);
    expect(changed()[0]).toMatchObject({
      tenant: plane.tenant,
      subject: doc,
      data: { seq: 1, chainHead: head1.chainHead },
    });
    expect(changed()[0]!.data['chainHead']).toMatch(/^[0-9a-f]{64}$/);

    // Two more commits inside the window: nothing is raised, and the latest waits.
    for (let i = 1; i <= 2; i++) {
      const r = await alice.submit(1, { base: i, steps: [insertText(intro(), `n${i}`)] });
      expect(r.t).toBe('sync.ack');
    }
    await until(() => sink.waiting === 1, 3000, 'the change to wait');
    expect(changed()).toHaveLength(1);

    // Before the window ends a flush raises nothing; after it, the last state of the burst.
    clock += CHANGE_WINDOW_MS - 1;
    sink.flush();
    expect(changed()).toHaveLength(1);
    clock += 1;
    sink.flush();
    expect(changed()).toHaveLength(2);
    const head3 = await plane.stores.logs.state!(ref);
    expect(head3.seq).toBe(3);
    expect(changed()[1]).toMatchObject({ data: { seq: 3, chainHead: head3.chainHead } });
    expect(head3.chainHead).not.toBe(head1.chainHead);
    expect(sink.waiting).toBe(0);
    expect(plane.errors).toEqual([]);
  });

  it('keeps the windows of two documents apart', async () => {
    const a = await plane.createDocument();
    const b = await plane.createDocument();
    const alice = await plane.client('alice', { [a]: 'owner', [b]: 'owner' });
    await alice.open(1, a);
    await alice.open(2, b);
    const before = raised.of('dep.document.changed.v1').length;
    expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'a')] })).t).toBe(
      'sync.ack',
    );
    expect((await alice.submit(2, { base: 0, steps: [insertText(intro(), 'b')] })).t).toBe(
      'sync.ack',
    );
    await until(
      () => raised.of('dep.document.changed.v1').length === before + 2,
      3000,
      'one event for each document',
    );
    const subjects = raised
      .of('dep.document.changed.v1')
      .slice(before)
      .map((e) => e.subject);
    expect(new Set(subjects)).toEqual(new Set([a, b]));
  });
});
