/**
 * HIS-019 criterion 2 (server half): a whole-document snapshot commit reaches every open client as
 * `sync.reset`, the history before it is not rewritten (the earlier commits read back unchanged),
 * and the snapshot takes a new `seq`. The client's reload on `sync.reset` is in packages/backend-dep
 * (see the header of snapshot-reset.test.ts); the restore reason `restore` is not built yet, the
 * data plane writes `import` for every replacement, so this test does not check the reason.
 * The real data plane runs over the in-memory stores (test/data-plane/support.ts).
 */
import type { JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_JSON, baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { REQUIRES, startPlane, type Plane } from '../../test/data-plane/support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function plane(): Promise<Plane> {
  const p = await startPlane();
  planes.push(p);
  return p;
}

/** The content a whole-document snapshot stores (06 §2.2); the fixture document, as in snapshot-reset. */
const fixtureContent = () =>
  ({ cdm: 1, requires: [...REQUIRES], doc: structuredClone(BASE_JSON) }) as unknown as JsonEnvelope;

describe('HIS-019 criterion 2: a whole-document snapshot resets every client and keeps the history', () => {
  it('sends sync.reset to every open client, keeps earlier commits unchanged, and takes a new seq', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' });
    await alice.open(1, doc);
    await bob.open(1, doc);

    // Two ordinary commits before the restore, so there is a history to keep.
    const first = await bob.submit(1, { base: 0, steps: [insertText(intro(), 'one ')] });
    expect(first.t).toBe('sync.ack');
    const second = await bob.submit(1, {
      base: (first.d as { seq: number }).seq,
      steps: [insertText(intro(), 'two ')],
    });
    expect(second.t).toBe('sync.ack');
    const headBefore = await p.stores.logs.head(p.ref(doc));
    const earlier = await p.stores.logs.read(p.ref(doc), 1, headBefore.seq);
    expect(earlier.length).toBe(headBefore.seq);

    const { seq } = await p.plane.replaceContent(p.ref(doc), fixtureContent(), 'alice');

    // A new seq, after the head before the snapshot.
    expect(seq).toBe(headBefore.seq + 1);
    // Every open client receives the reset at that seq.
    for (const c of [alice, bob]) {
      const reset = await c.take((m) => m.t === 'sync.reset');
      expect(reset.d).toMatchObject({ seq });
    }
    // The history is not rewritten: each earlier commit reads back exactly as it was written.
    const after = await p.stores.logs.read(p.ref(doc), 1, headBefore.seq);
    expect(after).toEqual(earlier);
    const headAfter = await p.stores.logs.head(p.ref(doc));
    expect(headAfter.seq).toBe(seq);
  });
});
