/**
 * A gap beyond the catch-up limits (BE-038 criterion 4; 05 §5.1 `catchUpCommits`; ADR 0034 §3).
 * The default limit is 5,000 commits; these tests set `catchUpCommits` to 3, so a gap of five is
 * beyond it and exercises the same branch. A resume inside the limit is streamed; a resume beyond
 * it is answered `reload`, also when the host serves the commits resource (the room would say
 * `page`, ADR 0034 §3, and the gateway turns that into `reload`). The paged read
 * `DataPlane.readCommits` returns the whole gap, in order, page by page. The real data plane runs
 * over the in-memory stores.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const LIMIT = 3;

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function plane(settings: Record<string, unknown>): Promise<Plane> {
  const p = await startPlane({ settings } as Parameters<typeof startPlane>[0]);
  planes.push(p);
  return p;
}

/** Alice writes six commits (seqs 1 to 6) on channel 1 and returns the incarnation and view. */
async function sixCommits(p: Plane, doc: string) {
  const alice = await p.client('alice', { [doc]: 'owner' });
  const first = await alice.open(1, doc);
  const seqs: number[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await alice.submit(1, { base: i, steps: [insertText(intro(), `${i}`)] });
    expect(r.t).toBe('sync.ack');
    seqs.push(r.d!['seq'] as number);
  }
  expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
  return {
    incarnation: first.d!['incarnation'] as string,
    view: first.d!['view'],
  };
}

describe('a gap beyond catchUpCommits is answered by the channel (BE-038 criterion 4)', () => {
  it('reloads a resume beyond the limit when the host does not serve the commits resource', async () => {
    const p = await plane({ limits: { catchUpCommits: LIMIT } });
    const doc = await p.createDocument();
    const { incarnation, view } = await sixCommits(p, doc);
    const bob = await p.client('bob', { [doc]: 'editor' });
    // Five commits are missing (2 to 6), more than the limit of three.
    const far = await bob.open(1, doc, { resume: { seq: 1, incarnation, view } });
    expect(far.d!['catchUp']).toBe('reload');
    // Inside the limit (three missing, 4 to 6) the same channel streams.
    const near = await p.client('carol', { [doc]: 'editor' });
    const streamed = await near.open(1, doc, { resume: { seq: 3, incarnation, view } });
    expect(streamed.d).toMatchObject({ catchUp: 'stream', head: 6 });
  });

  it('still answers reload for the same gap when the host serves the commits resource, and the pages hold the whole gap', async () => {
    const p = await plane({ limits: { catchUpCommits: LIMIT }, commitsResource: true });
    const doc = await p.createDocument();
    const { incarnation, view } = await sixCommits(p, doc);
    const bob = await p.client('bob', { [doc]: 'editor' });
    // The room would answer `page`, but the gateway turns a page into `reload` for the channel
    // (gateway.ts, `ch.opened`); the client then reads the pages itself.
    const opened = await bob.open(1, doc, { resume: { seq: 1, incarnation, view } });
    expect(opened.d).toMatchObject({ catchUp: 'reload', head: 6 });

    // The commits resource pages the gap, ascending and complete, at a limit of two.
    const id = p.tokens.identity(p.tokens.issue({ user: 'bob', docs: { [doc]: 'editor' } }));
    const pages: number[][] = [];
    let cursor: number | null = 1;
    while (cursor !== null) {
      const page = await p.plane.readCommits(id, doc, cursor, 2);
      pages.push(page.items.map((c) => c.seq));
      cursor = page.next;
    }
    expect(pages).toEqual([[2, 3], [4, 5], [6]]);
  });
});
