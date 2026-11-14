/**
 * Resuming a channel with catch-up by stream (PRO-025 criteria 1, 2, 4 and 6; 05 §5.2, §5.3).
 * A client that has confirmed `seq` opens the channel with `resume.seq` and its incarnation: the
 * server streams every commit after it, then `sync.caughtUp`, then live commits. The `inflight`
 * answer says whether a commit the client was sending was stored. A different incarnation, or a
 * `resume.seq` beyond the head, gets `catchUp: "reload"`. The real data plane runs over the
 * in-memory stores (test/data-plane/support.ts).
 */
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText, type DepClient, type Received } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

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

/** Two commits from alice on channel 1: returns their identifiers and sequence numbers. */
async function twoCommits(p: Plane, doc: string, alice: DepClient) {
  const first = await alice.open(1, doc);
  const incarnation = first.d!['incarnation'] as string;
  const ids = [uuid7(), uuid7()] as const;
  const a = await alice.submit(1, { id: ids[0], base: 0, steps: [insertText(intro(), 'one ')] });
  const b = await alice.submit(1, {
    id: ids[1],
    base: a.d!['seq'] as number,
    steps: [insertText(intro(), 'two ')],
  });
  return {
    incarnation,
    view: first.d!['view'],
    ids,
    seqs: [a.d!['seq'] as number, b.d!['seq'] as number] as const,
  };
}

describe('resume with catch-up by stream (PRO-025 criteria 1 and 2)', () => {
  it('chooses stream and sends the commits after resume.seq, then sync.caughtUp, then live commits', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const { incarnation, view, seqs } = await twoCommits(p, doc, alice);
    const bob = await p.client('bob', { [doc]: 'editor' });
    // The client has confirmed the first commit and misses the second.
    const opened = await bob.open(1, doc, { resume: { seq: seqs[0], incarnation, view } });
    expect(opened.d).toMatchObject({ head: seqs[1], catchUp: 'stream' });
    const caught = await bob.take((m) => m.t === 'sync.caughtUp');
    expect(caught.d).toMatchObject({ seq: seqs[1] });
    // Every commit after resume.seq is streamed before sync.caughtUp, in ascending order.
    const iCaught = bob.log.indexOf(caught);
    const streamed = bob.log
      .slice(0, iCaught)
      .filter((m) => m.t === 'sync.commit')
      .flatMap((m) => m.d!['commits'] as Array<{ seq: number }>)
      .map((c) => c.seq);
    expect(streamed).toEqual([seqs[1]]);
    // A live commit follows, at head + 1, after sync.caughtUp.
    await alice.submit(1, { base: seqs[1], steps: [insertText(intro(), 'live ')] });
    const live = await bob.take(
      (m) =>
        m.t === 'sync.commit' &&
        (m.d!['commits'] as Array<{ seq: number }>).some((c) => c.seq === seqs[1]! + 1),
    );
    expect(bob.log.indexOf(live)).toBeGreaterThan(iCaught);
  });
});

describe('resume.inflight names a commit that was stored or not (PRO-025 criterion 4)', () => {
  it('answers accepted with its seq, and the commit is in the stream', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const { incarnation, view, ids, seqs } = await twoCommits(p, doc, alice);
    // Only the author's own session can learn about its commit (the room compares the user).
    const again = await p.client('alice', { [doc]: 'owner' });
    const opened = await again.open(1, doc, {
      resume: { seq: seqs[0], incarnation, view, inflight: ids[1] },
    });
    expect(opened.d!['inflight']).toEqual({ state: 'accepted', seq: seqs[1] });
    await again.take((m) => m.t === 'sync.caughtUp');
    const streamed = again
      .all('sync.commit', 1)
      .flatMap((m) => m.d!['commits'] as Array<{ id: string }>);
    expect(streamed.map((c) => c.id)).toContain(ids[1]);
  });

  it('answers unknown for a commit that was never stored', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const { incarnation, view } = await twoCommits(p, doc, alice);
    const bob = await p.client('bob', { [doc]: 'editor' });
    const opened = await bob.open(1, doc, {
      resume: { seq: 0, incarnation, view, inflight: uuid7() },
    });
    expect(opened.d!['inflight']).toEqual({ state: 'unknown' });
  });
});

describe('a resume that cannot be streamed is answered with reload (PRO-025 criterion 6)', () => {
  it('reloads when the incarnation differs', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const { view } = await twoCommits(p, doc, alice);
    const bob = await p.client('bob', { [doc]: 'editor' });
    const opened: Received = await bob.open(1, doc, {
      resume: { seq: 1, incarnation: uuid7(), view },
    });
    expect(opened.t).toBe('ch.opened');
    expect(opened.d!['catchUp']).toBe('reload');
  });

  it('reloads when resume.seq is greater than the head', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const { incarnation, view, seqs } = await twoCommits(p, doc, alice);
    const bob = await p.client('bob', { [doc]: 'editor' });
    const opened = await bob.open(1, doc, {
      resume: { seq: seqs[1]! + 5, incarnation, view },
    });
    expect(opened.d!['catchUp']).toBe('reload');
  });
});
