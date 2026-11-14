/**
 * Block suggestions shown as markup (Node.js only): EXP-083 criterion 3, for paragraphs. A paragraph
 * whose paragraph mark is `ins` or `del` has its text runs marked in markup mode as if each run
 * carried the mark; a run's own mark of the same type is not added twice. Tables and table rows are
 * not marked yet (criterion 3 stays open). The tests read main.tex; nothing is compiled.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, run } from '../test/docs.ts';
import { delMark, insMark, markedPara, printed, text } from '../test/suggestions.ts';

const INSERT = '1F5FAD';
const DELETE = 'B3261E';

/** The TeX of main.tex from the first colour macro that wraps `words` up to the words. */
function wrappedBy(main: string, colour: string, macro: 'DEul' | 'DEst', words: string): boolean {
  const re = new RegExp(`\\\\DEc\\{${colour}\\}\\{\\\\${macro}\\{[^]*?${words}`);
  return re.test(main);
}

describe('EXP-083 criterion 3: block suggestions in markup', () => {
  it('marks a deleted paragraph as deleted, and an inserted one as inserted', async () => {
    const bundle = await run(
      doc([
        markedPara('Struck paragraph.', [delMark(1)]),
        markedPara('Added paragraph.', [insMark(2)]),
      ]),
      { suggestions: 'markup' },
    );
    const main = bundle.files['main.tex']!;
    expect(wrappedBy(main, DELETE, 'DEst', 'Struck paragraph\\.')).toBe(true);
    expect(wrappedBy(main, INSERT, 'DEul', 'Added paragraph\\.')).toBe(true);
    expect(printed(bundle)).toBe('Struck paragraph.Added paragraph.');
  });

  it('does not mark a plain paragraph', async () => {
    const bundle = await run(doc([para('Plain paragraph.')]), { suggestions: 'markup' });
    const main = bundle.files['main.tex']!;
    expect(main).not.toMatch(/\\DEc\{/);
    expect(main).not.toMatch(/\\DEst\{|\\DEul\{/);
  });

  it('does not add a second mark of the same kind to a run that already carries it', async () => {
    const own = { ...para('', {}, [text('Own insertion.', [insMark(4)])]), marks: [insMark(3)] };
    const bundle = await run(doc([own]), { suggestions: 'markup' });
    const main = bundle.files['main.tex']!;
    expect((main.match(/\\DEul\{/g) ?? []).length).toBe(1);
  });

  it('leaves marked paragraphs out under accept and reject, as before', async () => {
    const body = () =>
      doc([
        markedPara('Struck paragraph.', [delMark(1)]),
        markedPara('Added paragraph.', [insMark(2)]),
      ]);
    const accepted = await run(body(), { suggestions: 'accept' });
    const rejected = await run(body(), { suggestions: 'reject' });
    expect(printed(accepted)).toBe('Added paragraph.');
    expect(printed(rejected)).toBe('Struck paragraph.');
    expect(accepted.files['main.tex']).not.toMatch(/\\DEul\{|\\DEst\{/);
  });

  it('gives the same markup on every run', async () => {
    const env = doc([markedPara('Struck paragraph.', [delMark(1)])]);
    const a = await run(env, { suggestions: 'markup' });
    const b = await run(env, { suggestions: 'markup' });
    expect(b.files).toEqual(a.files);
  });
});
