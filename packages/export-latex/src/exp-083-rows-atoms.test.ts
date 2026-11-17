/**
 * Row, table and atom suggestions shown as markup (Node.js only): EXP-083 criterion 3. A whole row
 * or table with `ins` or `del` has the paragraphs in it marked as the paragraph is (the same
 * underline and strike-through, the same colours); an inline atom (equation, image, field) with a
 * mark is wrapped as a run is. Nothing is compiled here; the compiled PDF is in
 * `exp-083-rows-atoms.compile.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, run, type J } from '../test/docs.ts';
import { delMark, insMark, printed, tableOf, text } from '../test/suggestions.ts';
import { settleSuggestions } from './suggestions.ts';

const INSERT = '1F5FAD';
const DELETE = 'B3261E';

/** Whether `words` come inside a colour macro of `colour` that holds `macro`. */
function wrapped(main: string, colour: string, macro: 'DEul' | 'DEst', words: string): boolean {
  return new RegExp(`\\\\DEc\\{${colour}\\}\\{\\\\${macro}\\{[^]*?${words}`).test(main);
}

describe('EXP-083 criterion 3: rows, tables and atoms', () => {
  it('marks the cells of a deleted row as deleted and leaves the other row unmarked', async () => {
    const table = tableOf([{ cells: ['row one'] }, { cells: ['row two'], marks: [delMark(1)] }]);
    const bundle = await run(doc([table]), { suggestions: 'markup' });
    const main = bundle.files['main.tex']!;
    expect(wrapped(main, DELETE, 'DEst', 'row two')).toBe(true);
    expect(main.match(/\\DEc\{/g)?.length).toBe(1);
    expect(printed(bundle)).toBe('row onerow two');
  });

  it('marks every cell of an inserted table as inserted, and of a deleted table as deleted', async () => {
    const bundle = await run(
      doc([
        tableOf([{ cells: ['added a', 'added b'] }], [insMark(2)]),
        tableOf([{ cells: ['struck'] }, { cells: ['struck too'] }], [delMark(3)]),
      ]),
      { suggestions: 'markup' },
    );
    const main = bundle.files['main.tex']!;
    expect(wrapped(main, INSERT, 'DEul', 'added a')).toBe(true);
    expect(wrapped(main, INSERT, 'DEul', 'added b')).toBe(true);
    expect(wrapped(main, DELETE, 'DEst', 'struck\\b')).toBe(true);
    expect(wrapped(main, DELETE, 'DEst', 'struck too')).toBe(true);
  });

  it('does not mark a row twice when its cell text carries the same suggestion', async () => {
    const own: J = {
      type: 'table',
      attrs: { id: 'tOwnOwnOwnOwnOw', grid: [2880] },
      content: [
        {
          type: 'table_row',
          attrs: { id: 'rOwnOwnOwnOwnOw' },
          marks: [insMark(4)],
          content: [
            {
              type: 'table_cell',
              attrs: { id: 'cOwnOwnOwnOwnOw' },
              content: [para('', {}, [text('own', [insMark(5)])])],
            },
          ],
        },
      ],
    };
    const bundle = await run(doc([own]), { suggestions: 'markup' });
    expect(bundle.files['main.tex']!.match(/\\DEul\{/g)?.length).toBe(1);
  });

  it('wraps an inline atom that carries a mark, as it wraps a run', async () => {
    const equation = (marks: J[]): J => ({
      type: 'equation',
      attrs: { id: 'eqAtomAtomAtomAt', latex: 'x^2' },
      marks,
    });
    const bundle = await run(
      doc([
        para('', {}, [text('See '), equation([insMark(6)]), text(' and '), equation([delMark(7)])]),
      ]),
      { suggestions: 'markup' },
    );
    const main = bundle.files['main.tex']!;
    expect(main).toMatch(/\\DEc\{1F5FAD\}\{\\DEul\{\\DEa\{\d+\}\{\\DEmath/);
    expect(main).toMatch(/\\DEc\{B3261E\}\{\\DEst\{\\DEa\{\d+\}\{\\DEmath/);
  });

  it('wraps an atom inside a deleted paragraph, and leaves atoms alone under accept and reject', async () => {
    const eq: J = { type: 'equation', attrs: { id: 'eqPlainPlainPlai', latex: 'y' } };
    const struck = { ...para('', {}, [eq]), marks: [delMark(8)] };
    const markup = await run(doc([structuredClone(struck)]), { suggestions: 'markup' });
    expect(markup.files['main.tex']).toMatch(/\\DEc\{B3261E\}\{\\DEst\{\\DEa\{/);
    const accepted = await run(doc([structuredClone(struck)]), { suggestions: 'accept' });
    expect(accepted.files['main.tex']).not.toMatch(/\\DEc\{/);
  });

  it('puts the paragraph marks only in markup mode, and does not change the document', () => {
    const table = tableOf([{ cells: ['a'], marks: [delMark(9)] }]);
    const env = doc([table]);
    const before = JSON.stringify(env);
    expect(settleSuggestions(env.doc as never, 'accept', [])).toBe(env.doc);
    expect(settleSuggestions(env.doc as never, 'reject', [])).toBe(env.doc);
    expect(settleSuggestions(env.doc as never, 'markup', [])).not.toBe(env.doc);
    expect(JSON.stringify(env)).toBe(before);
  });
});
