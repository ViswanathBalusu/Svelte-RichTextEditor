/**
 * FE-010 (lane U-FE-001-016): the recovered edits the journal keeps for a document. The port round
 * trip, with the in-memory journal; the IndexedDB store and the reopen are proven in the browser
 * (packages/element/e2e/fe-010-recovered-reopen.spec.ts).
 */
import { describe, expect, it } from 'vitest';
import { type Discarded, memoryJournal } from '../src/index.ts';

const item = (seq: number, text: string): Discarded => ({
  reason: 'permission_denied',
  commit: `01a1d829-b274-759f-9396-0bdb82c0639${seq}`,
  steps: [
    { stepType: 'replace', from: 1, to: 1, slice: { content: [{ type: 'text', text }] } },
  ] as never,
  text,
  seq,
  scopes: ['region:rLegal0000000001'],
});

describe('FE-010 recovered edits in the journal', () => {
  it('keeps the set-aside items of one document, oldest first, and returns copies', async () => {
    const journal = memoryJournal();
    expect(await journal.readRecovered?.('doc-a')).toEqual([]);
    await journal.setRecovered?.('doc-a', [item(1, 'a')]);
    await journal.setRecovered?.('doc-a', [item(1, 'a'), item(2, 'b')]);
    await journal.setRecovered?.('doc-b', [item(3, 'c')]);
    const back = (await journal.readRecovered?.('doc-a')) ?? [];
    expect(back.map((i) => i.text)).toEqual(['a', 'b']);
    expect(back[0]).toEqual(item(1, 'a'));
    // A copy: changing what was read does not change the journal. The port types the result as
    // readonly, so the test casts to reach the mutation a caller could attempt at run time.
    (back as Discarded[]).pop();
    expect((await journal.readRecovered?.('doc-a'))?.length).toBe(2);
    expect((await journal.readRecovered?.('doc-b'))?.map((i) => i.text)).toEqual(['c']);
  });

  it('removes the recovered edits of a document when it sets none', async () => {
    const journal = memoryJournal();
    await journal.setRecovered?.('doc-a', [item(1, 'a')]);
    await journal.setRecovered?.('doc-a', []);
    expect(await journal.readRecovered?.('doc-a')).toEqual([]);
  });
});
