/**
 * BE-037 criterion 1 (lane BE-027-039, round 2): `PUT /documents/{id}/content` becomes a snapshot
 * commit with origin `import` that is written to the outbox and delivered from it (BE-039), and the
 * connected channels receive `sync.reset` and reload at its seq. The real data plane runs over the
 * in-memory stores; the outbox is `MemoryOutbox`, wrapped so that the test can see the row written
 * for the replacement.
 */
import type { JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_JSON } from '../../../../packages/authority/test/fixtures.ts';
import { REQUIRES, startPlane, type Plane } from '../../test/data-plane/support.ts';
import type { NewOutboxItem, OutboxItem } from '../storage/types.ts';
import { MemoryOutbox } from './memory-ports.ts';

/** A memory outbox that keeps the items written to it, in the order they were written. */
class RecordingOutbox extends MemoryOutbox {
  readonly written: NewOutboxItem[] = [];
  readonly rows: OutboxItem[] = [];
  override async enqueue(item: NewOutboxItem): Promise<OutboxItem> {
    this.written.push(item);
    const row = await super.enqueue(item);
    this.rows.push(row);
    return row;
  }
}

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** The content of the fixture document, as a replacement carries it. */
const fixtureContent = () =>
  ({ cdm: 1, requires: [...REQUIRES], doc: structuredClone(BASE_JSON) }) as unknown as JsonEnvelope;

describe('PUT content is a snapshot commit through the outbox (BE-037 criterion 1)', () => {
  it('writes an import snapshot to the outbox, delivers it, and sends sync.reset to each open channel', async () => {
    const outbox = new RecordingOutbox(() => Date.now());
    const p = await startPlane({ deps: { outbox } });
    planes.push(p);
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' });
    await alice.open(1, doc);
    await bob.open(1, doc);

    const { seq } = await p.plane.replaceContent(ref, fixtureContent(), 'alice');

    // The replacement was written to the outbox as a snapshot with reason import, and settled done.
    expect(outbox.written).toHaveLength(1);
    const row = outbox.written[0]!;
    expect(row).toMatchObject({ tenant: ref.tenant, doc, kind: 'snapshot' });
    expect(row.request).toMatchObject({ reason: 'import', actor: 'alice' });
    expect(row.payload).toBeInstanceOf(Uint8Array);
    // The row was delivered by the outbox (the replacement answers with the seq it stored).
    expect(await outbox.get(ref.tenant, outbox.rows[0]!.id)).toMatchObject({
      state: 'done',
      result: { seq },
    });

    // The log holds that one snapshot commit at the seq the request was answered with.
    expect(seq).toBeGreaterThan(0);
    expect((await p.stores.logs.head(ref)).seq).toBe(seq);
    const [stored] = await p.stores.logs.read(ref, seq, seq);
    expect(stored).toMatchObject({ seq, kind: 'snapshot' });

    // Every open channel is told to reset to that seq with reason import, and reloads from it.
    for (const c of [alice, bob]) {
      const reset = await c.take((m) => m.t === 'sync.reset');
      expect(reset.ch).toBe(1);
      expect(reset.d).toMatchObject({ seq, reason: 'import' });
    }
    expect(p.errors).toEqual([]);
  });
});
