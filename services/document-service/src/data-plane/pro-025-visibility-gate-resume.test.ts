/**
 * Resuming a channel below the reader's visibility gate (PRO-025 criterion 6; 05 §5.2; PRM-041,
 * PRM-042; HIS-024). A viewer under the default `editors` setting may see nothing below the head, so
 * a channel opened with a `resume.seq` below the head must get `catchUp: "reload"` and no commit
 * from before the gate. The real data plane runs over the in-memory stores (test/data-plane/support.ts).
 */
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
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

describe('resume below the visibility gate reloads (PRO-025 criterion 6)', () => {
  it('a viewer under `editors` who resumes below the head gets catchUp reload, and no commit before the gate', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const first = await alice.open(1, doc);
    const incarnation = first.d!['incarnation'] as string;
    const a = await alice.submit(1, { id: uuid7(), base: 0, steps: [insertText(intro(), 'one ')] });
    const seq1 = a.d!['seq'] as number;
    const b = await alice.submit(1, {
      id: uuid7(),
      base: seq1,
      steps: [insertText(intro(), 'two ')],
    });
    const head = b.d!['seq'] as number;
    expect(head).toBeGreaterThan(seq1);

    // Frank is a viewer: under `editors` his gate is the head, so nothing below it is visible.
    const frank = await p.client('frank', { [doc]: 'viewer' });
    const viewerOpen = await frank.open(1, doc);
    const view = viewerOpen.d!['view'] as string;
    expect(viewerOpen.d).toMatchObject({ head, catchUp: 'reload' });
    frank.close();

    // A fresh channel that resumes at a seq below the gate is told to reload.
    const again = await p.client('frank', { [doc]: 'viewer' });
    const refused = await again.open(1, doc, { resume: { seq: seq1, incarnation, view } });
    expect(refused.d!['catchUp']).toBe('reload');
    expect(refused.d!['head']).toBe(head);
    again.close();

    // Control: an editor, whose gate is below seq1, resumes at the same seq by stream.
    const editor = await p.client('bob', { [doc]: 'editor' });
    const editorFirst = await editor.open(1, doc);
    const editorView = editorFirst.d!['view'] as string;
    editor.close();
    const editorAgain = await p.client('bob', { [doc]: 'editor' });
    const editorOpen = await editorAgain.open(1, doc, {
      resume: { seq: seq1, incarnation, view: editorView },
    });
    expect(editorOpen.d).toMatchObject({ head, catchUp: 'stream' });
    editorAgain.close();

    // At the gate (the head) the same viewer resumes by stream and receives no older commit.
    const atGate = await p.client('frank', { [doc]: 'viewer' });
    const ok = await atGate.open(1, doc, { resume: { seq: head, incarnation, view } });
    expect(ok.d).toMatchObject({ head, catchUp: 'stream' });
    const caught = await atGate.take((m) => m.t === 'sync.caughtUp');
    expect(caught.d).toMatchObject({ seq: head });
    const streamed = atGate.log
      .filter((m) => m.t === 'sync.commit')
      .flatMap((m) => m.d!['commits'] as Array<{ seq: number }>)
      .map((c) => c.seq);
    expect(streamed.every((s) => s > seq1)).toBe(true);
    atGate.close();
  });
});
