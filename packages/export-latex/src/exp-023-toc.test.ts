/**
 * Tables of contents and lists of captions (Node.js only): the converter's side of EXP-023
 * criteria 1 and 2. The tests read the `\DEtoc` and `\DElistof` lines of main.tex. They do not show
 * that the entries exist, that their page numbers are right or that they link to their targets:
 * those need a compiled PDF, which is not run here, so no criterion of EXP-023 is ticked by this file.
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, run, type J } from '../test/docs.ts';

const toc = (attrs: J): J => ({ type: 'toc', attrs: { id: nid('c'), ...attrs } });

/** The arguments of every `\DEtoc{n}{min}{max}` in main.tex, in order. */
const tocArgs = (main: string): string[][] =>
  [...main.matchAll(/\\DEtoc\{\d+\}\{(\d+)\}\{(\d+)\}/g)].map((m) => [m[1]!, m[2]!]);

describe('EXP-023 criterion 1 (converter side): a toc of headings takes its minimum and maximum level', () => {
  it('writes the minimum and maximum level of the range', async () => {
    const bundle = await run(
      doc([toc({ minLevel: 2, maxLevel: 3, of: 'headings' }), para('Body.')]),
    );
    expect(tocArgs(bundle.files['main.tex']!)).toEqual([['2', '3']]);
  });

  it('keeps the maximum level at least the minimum, and within nine levels', async () => {
    const bundle = await run(
      doc([toc({ minLevel: 4, maxLevel: 2, of: 'headings' }), para('Body.')]),
    );
    expect(tocArgs(bundle.files['main.tex']!)).toEqual([['4', '4']]);
  });
});

describe('EXP-023 criterion 2 (converter side): a toc of a caption sequence asks for that list', () => {
  it('writes \\DElistof for a sequence name, and its list number is one per distinct name', async () => {
    const bundle = await run(
      doc([toc({ of: 'Figure' }), toc({ of: 'Table' }), toc({ of: 'Figure' })]),
    );
    const main = bundle.files['main.tex']!;
    expect([...main.matchAll(/\\DElistof\{\d+\}\{(\d+)\}/g)].map((m) => m[1])).toEqual([
      '1',
      '2',
      '1',
    ]);
  });
});
