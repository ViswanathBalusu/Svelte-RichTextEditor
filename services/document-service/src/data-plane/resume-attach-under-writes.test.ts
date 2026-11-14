/**
 * A client that attaches with catch-up by stream while commits keep arriving (PRO-025 criterion 3;
 * 05 §5.2, §5.3). The attach and the stream are atomic on the server, so the client receives each
 * commit after `resume.seq` exactly once and in ascending order, with the live commits after them.
 * One writer keeps committing; the criterion asks for writers in the plural, so this is a partial
 * check. It runs over the in-memory stores (test/data-plane/support.ts), not PostgreSQL.
 */
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText, type DepClient } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

/** The sequence numbers of every commit the client has received, in arrival order. */
function received(c: DepClient): number[] {
  return c.log
    .filter((m) => m.t === 'sync.commit')
    .flatMap((m) => (m.d!['commits'] as Array<{ seq: number }>).map((x) => x.seq));
}

describe('attaching while commits keep arriving (PRO-025 criterion 3, one writer)', () => {
  it('a client that attaches under a stream of commits receives each once, in order, then the live ones', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const first = await alice.open(1, doc);
    const incarnation = first.d!['incarnation'] as string;
    const view = first.d!['view'];

    let base = 0;
    const write = async (n: number, text: string) => {
      for (let i = 0; i < n; i++) {
        const ack = await alice.submit(1, {
          id: uuid7(),
          base,
          steps: [insertText(intro(), text)],
        });
        expect(ack.t).toBe('sync.ack');
        base = ack.d!['seq'] as number;
      }
    };
    await write(5, 'a ');
    const resumeSeq = base;

    // Bob attaches while alice's commits continue; the attach is sent before the writes start.
    const bob = await p.client('bob', { [doc]: 'editor' });
    const attach = bob.open(1, doc, { resume: { seq: resumeSeq, incarnation, view } });
    await write(40, 'b ');
    const opened = await attach;
    expect(opened.d).toMatchObject({ catchUp: 'stream' });
    // The head the attach saw is not before the resume point. It is not asserted to be before the
    // last write: the in-memory store may finish the writes before the attach is handled.
    const headAtAttach = opened.d!['head'] as number;
    expect(headAtAttach).toBeGreaterThanOrEqual(resumeSeq);

    const last = base;
    const deadline = Date.now() + 5000;
    while ((received(bob).at(-1) ?? 0) !== last) {
      if (Date.now() > deadline) throw new Error(`bob did not reach seq ${last}`);
      await sleep(5);
    }
    const expected = Array.from({ length: last - resumeSeq }, (_, i) => resumeSeq + 1 + i);
    expect(received(bob)).toEqual(expected);
    expect(new Set(received(bob)).size).toBe(received(bob).length);
  });
});
