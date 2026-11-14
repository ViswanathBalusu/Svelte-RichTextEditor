/**
 * Server-authored operations on a document that is not open (SYN-031; BE-023; 06 §2.2, last
 * paragraph). `RoomHost.apply` runs a transient authority when no room of the document is open on
 * the node. These tests use the real data plane over the in-memory stores, with no channel open
 * for the document, so the room that applies the commit is the transient one.
 */
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
async function plane(...args: Parameters<typeof startPlane>): Promise<Plane> {
  const p = await startPlane(...args);
  planes.push(p);
  return p;
}
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('transient authority for a closed document (SYN-031)', () => {
  it('applies a server-authored commit to a document with no open room, stores it, and leaves nothing held', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    expect(p.plane.host.get(ref)).toBeUndefined();

    const r = await p.plane.host.apply(ref, {
      kind: 'author',
      id: uuid7(),
      origin: 'prefill',
      actor: 'system',
      base: 0,
      steps: [insertText(intro(), 'Prefilled')],
    });
    expect(r.seq).toBe(1);

    // The transient authority exited: no room is registered, and none is in progress.
    expect(p.plane.host.rooms).toHaveLength(0);
    expect(p.plane.host.get(ref)).toBeUndefined();
    expect(p.plane.host.transientCount).toBe(0);

    // The commit is in the log: a client that opens the document now starts from head 1.
    const c = await p.client('alice', { [doc]: 'owner' });
    expect((await c.open(1, doc)).t).toBe('ch.opened');
    const next = await c.submit(1, { base: 1, steps: [insertText(intro(), 'after')] });
    expect(next.t).toBe('sync.ack');
    expect(next.d).toMatchObject({ seq: 2 });
  });

  it('loads the log tail when the document already has commits, and applies the next one on top', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    // No checkpoint is written between the two runs (the policy needs 2,000 commits), so the second
    // transient authority must load commit 1 from the log tail before it applies commit 2.
    const first = await p.plane.host.apply(ref, {
      kind: 'author',
      id: uuid7(),
      origin: 'prefill',
      actor: 'system',
      base: 0,
      steps: [insertText(intro(), 'One')],
    });
    const second = await p.plane.host.apply(ref, {
      kind: 'author',
      id: uuid7(),
      origin: 'prefill',
      actor: 'system',
      base: 1,
      steps: [insertText(intro(), 'Two')],
    });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(p.plane.host.transientCount).toBe(0);
    expect(p.plane.host.rooms).toHaveLength(0);
  });

  it('applies a retried server-authored commit with the same deterministic id once', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const op = {
      kind: 'author' as const,
      id: uuid7(),
      origin: 'prefill',
      actor: 'system',
      base: 0,
      steps: [insertText(intro(), 'Once')],
    };
    const first = await p.plane.host.apply(ref, op);
    const again = await p.plane.host.apply(ref, op);
    expect(first.seq).toBe(1);
    expect(again.seq).toBe(1);
    expect(p.plane.host.transientCount).toBe(0);

    // Only one commit was stored: the head is 1, so a commit based on 1 is the next one.
    const c = await p.client('alice', { [doc]: 'owner' });
    expect((await c.open(1, doc)).t).toBe('ch.opened');
    const next = await c.submit(1, { base: 1, steps: [insertText(intro(), 'after')] });
    expect(next.t).toBe('sync.ack');
    expect(next.d).toMatchObject({ seq: 2 });
  });
});
