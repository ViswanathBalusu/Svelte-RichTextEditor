/**
 * A snapshot commit reaches every channel as `sync.reset` (PRO-030 criterion 1; 05 §5.3; 04 §3.2).
 * The server half is tested here: the reset carries the `seq` of the snapshot and its `reason`,
 * the requester continues from `seq` (its next commit is acknowledged with `seq + 1`), and a commit
 * whose base is older than the snapshot is refused. The client's reload on `sync.reset` and its
 * handling of `sync.check` (criteria 2, 4 and 5) are in packages/backend-dep and packages/protocol.
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

/** The content of the fixture document, as a snapshot commit stores it (06 §2.2). */
const fixtureContent = () =>
  ({ cdm: 1, requires: [...REQUIRES], doc: structuredClone(BASE_JSON) }) as unknown as JsonEnvelope;

describe('a snapshot commit is sent to every channel as sync.reset (PRO-030 criterion 1)', () => {
  it('sends sync.reset with the snapshot seq and reason import to each open channel', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' });
    await alice.open(1, doc);
    await bob.open(1, doc);
    const { seq } = await p.plane.replaceContent(p.ref(doc), fixtureContent(), 'alice');
    expect(seq).toBeGreaterThan(0);
    for (const c of [alice, bob]) {
      const reset = await c.take((m) => m.t === 'sync.reset');
      expect(reset.ch).toBe(1);
      expect(reset.d).toMatchObject({ seq, reason: 'import' });
    }
  });

  it('continues from the snapshot: the next commit on the snapshot base is acknowledged with seq + 1', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const bob = await p.client('bob', { [doc]: 'editor' });
    await bob.open(1, doc);
    const { seq } = await p.plane.replaceContent(p.ref(doc), fixtureContent(), 'alice');
    await bob.take((m) => m.t === 'sync.reset');
    const r = await bob.submit(1, { base: seq, steps: [insertText(intro(), 'after ')] });
    expect(r.t).toBe('sync.ack');
    expect(r.d).toMatchObject({ seq: seq + 1 });
  });
});

describe('a commit based on a state before a snapshot is refused (PRO-030 criterion 3)', () => {
  it('refuses a commit whose base is older than the snapshot with a rebase action, not a reload', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const bob = await p.client('bob', { [doc]: 'editor' });
    await bob.open(1, doc);
    const { seq } = await p.plane.replaceContent(p.ref(doc), fixtureContent(), 'alice');
    await bob.take((m) => m.t === 'sync.reset');
    const r = await bob.submit(1, { base: seq - 1, steps: [insertText(intro(), 'stale ')] });
    expect(r.t).toBe('sync.reject');
    // The story says `reload`; the second review (SR-K1, 04 §3.2 as edited) says `stale_base` with
    // `rebase`. The test records what the server does and that the base was before the snapshot.
    expect(r.d).toMatchObject({ code: 'stale_base', action: 'rebase' });
    expect(seq).toBeGreaterThan(0);
  });
});
