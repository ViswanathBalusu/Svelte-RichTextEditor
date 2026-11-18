/**
 * FE-130 criterion 3, the PDF side (Node.js only, sandbox): the labels of a list printed in the
 * compiled PDF are the labels the editor shows, which both read from the model's `computeLabels`
 * (CDM-042). The document has a list, a second list instance that restarts the numbering with the
 * same definition, and a later item that continues the first list (the shape the editor's
 * `restartNumbering` and `continueNumbering` commands leave: a new or an earlier `listId`, see
 * packages/engine/src/list-commands.ts). The test reads the PDF's text, so a label that main.tex
 * prints and the class then changes would show.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { computeLabels, type TreeNode } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;

const numbering: J = {
  type: 'numbering_def',
  attrs: {
    id: 'n',
    levels: [
      { format: 'decimal', text: '%1.', start: 1 },
      { format: 'decimal', text: '%1.%2.', start: 1 },
    ],
  },
};

const item = (content: string, level: number, listId: string): J =>
  para(content, { numbering: { numberingId: 'n', level, listId } });

describe.skipIf(!ready)('FE-130 criterion 3: list labels in the PDF follow computeLabels', () => {
  it('prints the labels of a list, a restarted list and a continued list as the editor computes them', async () => {
    const items = [
      item('Aardvark', 0, 'listA'),
      item('Badger', 0, 'listA'),
      item('Cheetah', 1, 'listA'),
      // The numbering restarts here: the same definition, a new list instance.
      item('Dingo', 0, 'listB'),
      item('Echidna', 0, 'listB'),
      // The first list continues after the restarted one.
      item('Ferret', 0, 'listA'),
    ];
    const envelope = doc([...items, para('END')], { numberings: [numbering] });
    const labels = computeLabels(envelope.doc as TreeNode).lists;
    const expected = items.map((p) => labels.get(idOf(p))?.text ?? '');
    // The shared computation counts per list instance: 1. 2. 2.1. then 1. 2. then 3.
    expect(expected).toEqual(['1.', '2.', '2.1.', '1.', '2.', '3.']);

    const c = await convertAndCompile(envelope, {
      profile: 'preview',
      title: 'fe-130-list-labels',
      instant: '2026-11-06T10:00:00.000Z',
      timeZone: 'Europe/London',
      suggestions: 'accept',
    } as never);
    if (!c.compile.ok || !c.compile.pdf)
      throw new Error(
        `the compile failed (${keep('fe-130-list-labels', c)}):\n${c.compile.log.slice(-1500)}`,
      );
    const text = pdfText(c.compile.pdf);
    if (text === null) throw new Error('pdftotext is not installed or failed');
    const flat = text.replace(/\s+/g, ' ');
    const words = ['Aardvark', 'Badger', 'Cheetah', 'Dingo', 'Echidna', 'Ferret'];
    words.forEach((word, i) => {
      expect(flat, `the label of ${word}`).toContain(`${expected[i]} ${word}`);
    });
  }, 180_000);
});
