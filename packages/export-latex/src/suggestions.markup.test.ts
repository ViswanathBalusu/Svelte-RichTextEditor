/**
 * Suggestions as markup in the output (Node.js only): EXP-083, with the markup case of EXP-082
 * criterion 2 (the request is accepted; the service half is not in this package). The tests read
 * main.tex: the insertions and deletions are written in colour through the `color` emitter, with a
 * non-colour cue (underline for an insertion, strike-through for a deletion), and both kinds of text
 * are printed. Not ticked here: the PDF's extracted text and its rendering (they need a LuaLaTeX
 * run, which this package does not do), the block marking of rows and tables (not built; they
 * print as they are), and the cue of atoms (only text runs are marked). A marked paragraph is
 * marked through its text runs: each run takes the paragraph's insertion or deletion mark.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, run, type J } from '../test/docs.ts';
import { delMark, insMark, markedPara, printed, text } from '../test/suggestions.ts';

const INSERT = '1F5FAD';
const DELETE = 'B3261E';

/** Every `\DEc{colour}{\DEul{...}}` and `\DEc{colour}{\DEst{...}}` that main.tex holds, by kind. */
function markupCount(main: string): {
  underline: number;
  strike: number;
  insertColour: number;
  deleteColour: number;
} {
  return {
    underline: (main.match(/\\DEul\{/g) ?? []).length,
    strike: (main.match(/\\DEst\{/g) ?? []).length,
    insertColour: (main.match(new RegExp(`\\\\DEc\\{${INSERT}\\}\\{\\\\DEul\\{`, 'g')) ?? [])
      .length,
    deleteColour: (main.match(new RegExp(`\\\\DEc\\{${DELETE}\\}\\{\\\\DEst\\{`, 'g')) ?? [])
      .length,
  };
}

function sample(): J[] {
  return [
    para('', {}, [
      text('Keep '),
      text('gone', [delMark(1)]),
      text('new ', [insMark(2)]),
      text('end.'),
    ]),
    markedPara('Struck paragraph.', [delMark(3)]),
  ];
}

describe('EXP-083 suggestions as markup (converter side)', () => {
  it('keeps both inserted and deleted text in the output', async () => {
    const bundle = await run(doc(sample()), { suggestions: 'markup' });
    expect(bundle.ok).toBe(true);
    expect(printed(bundle)).toBe('Keep gonenew end.Struck paragraph.');
  });

  it('writes insertions in the insertion colour and underlined, deletions in the deletion colour and struck through', async () => {
    const bundle = await run(doc(sample()), { suggestions: 'markup' });
    const c = markupCount(bundle.files['main.tex']!);
    // The text runs 'gone' and 'new ' are marked, and so is the text of the struck paragraph: a
    // deleted paragraph marks every run it holds as deleted (EXP-083 criterion 3).
    expect(c.insertColour).toBe(1);
    expect(c.underline).toBe(1);
    expect(c.deleteColour).toBe(2);
    expect(c.strike).toBe(2);
    const struck = [
      ...bundle.files['main.tex']!.matchAll(
        new RegExp(`\\\\DEc\\{${DELETE}\\}\\{\\\\DEst\\{`, 'g'),
      ),
    ];
    expect(struck).toHaveLength(2);
    // The second pair wraps the whole text of the struck paragraph, and nothing else.
    const second = bundle.files['main.tex']!.slice(struck[1]!.index);
    expect(second.startsWith(`\\DEc{${DELETE}}{\\DEst{\\DEr{0}{Struck paragraph.}}}`)).toBe(true);
  });

  it('gives the colours as six hexadecimal digits from the colour emitter, and leaves unmarked text unmarked', async () => {
    const bundle = await run(doc(sample()), { suggestions: 'markup' });
    const main = bundle.files['main.tex']!;
    for (const m of main.matchAll(/\\DEc\{([^}]*)\}/g)) expect(m[1]).toMatch(/^[0-9A-F]{6}$/);
    // The unmarked run 'Keep ' is not inside an underline, a strike-through or a colour.
    const at = main.indexOf('\\DEr{0}{Keep');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(main.slice(Math.max(0, at - 24), at)).not.toMatch(/DEul\{|DEst\{|DEc\{/);
  });

  it('keeps the non-colour cue apart from the colour: the two kinds differ by underline or strike-through', async () => {
    const bundle = await run(doc(sample()), { suggestions: 'markup' });
    const main = bundle.files['main.tex']!;
    const underlined = [...main.matchAll(/\\DEul\{/g)].length;
    const struck = [...main.matchAll(/\\DEst\{/g)].length;
    expect(underlined).toBeGreaterThan(0);
    expect(struck).toBeGreaterThan(0);
    expect(main).not.toMatch(new RegExp(`\\\\DEc\\{${INSERT}\\}\\{\\\\DEst`));
    expect(main).not.toMatch(new RegExp(`\\\\DEc\\{${DELETE}\\}\\{\\\\DEul`));
  });

  it('gives a diagnostic that the pagination differs, once, when suggestions are shown as markup', async () => {
    const bundle = await run(doc(sample()), { suggestions: 'markup' });
    const notes = bundle.diagnostics.filter((d) => d.code === 'markup_pagination');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.severity).toBe('info');
  });

  it('gives no pagination note for accept or reject, and none when the document has no suggestions', async () => {
    const accepted = await run(doc(sample()), { suggestions: 'accept' });
    const rejected = await run(doc(sample()), { suggestions: 'reject' });
    const plain = await run(doc([para('Plain.')]), { suggestions: 'markup' });
    for (const b of [accepted, rejected, plain]) {
      expect(b.diagnostics.map((d) => d.code)).not.toContain('markup_pagination');
    }
  });

  it('writes the same markup on every run', async () => {
    const env = doc(sample());
    const a = await run(env, { suggestions: 'markup' });
    const b = await run(env, { suggestions: 'markup' });
    expect(b.files).toEqual(a.files);
  });
});
