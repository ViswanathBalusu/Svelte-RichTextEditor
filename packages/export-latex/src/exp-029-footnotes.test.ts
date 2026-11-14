/**
 * Footnotes (Node.js only): EXP-029 criterion 4 (a one-paragraph footnote is set in the
 * FootnoteText style) and the mark format of criterion 2 (settings.footnoteFormat). The tests read
 * main.tex and styles.tex of the converter's bundle; nothing compiles, so the PDF is not inspected.
 * Criterion 1 (\footnote where LaTeX allows it) is not covered: the converter always writes
 * \DEfnmark and \DEfntext, so the story's \footnote branch is not built.
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, run, type J } from '../test/docs.ts';
import { dimen } from './emit.ts';

const SIZE = { min: 20, max: 32760 };
const style = (id: string, attrs: J): J => ({
  type: 'style_def',
  attrs: { id, kind: 'paragraph', name: id, ...attrs },
});

/** A footnote whose one paragraph holds `text`. */
const footnote = (text: string): J => ({
  type: 'footnote',
  attrs: { id: nid('f') },
  content: [{ type: 'paragraph', attrs: { id: nid('q') }, content: [{ type: 'text', text }] }],
});

/** The body of the style macro named by `\DEfntext{n}{mark}{<macro>...`, from styles.tex. */
function footnoteStyleBody(main: string, styles: string): string {
  const name = /\\DEfntext\{\d+\}\{[^}]*\}\{(\\DES[a-zA-Z]+)/.exec(main)?.[1];
  if (!name) throw new Error('no footnote text with a style macro');
  const def = styles.split('\n').find((l) => l.startsWith(`\\def${name}{`));
  if (!def) throw new Error(`no definition of ${name}`);
  return def.slice(`\\def${name}{`.length, -1);
}

describe('EXP-029 criterion 4: a one-paragraph footnote is set in the FootnoteText style', () => {
  it('gives the footnote paragraph the FootnoteText style macro, which carries its size', async () => {
    const styles = [style('FootnoteText', { fontSize: 1000 })];
    const body = para('Body.', {}, [footnote('Note text.')]);
    const bundle = await run(doc([body], { styles }));
    const body2 = footnoteStyleBody(bundle.files['main.tex']!, bundle.files['styles.tex']!);
    expect(body2).toContain(`\\DEsz{${dimen(1000, SIZE)}}`);
  });
});

describe('EXP-029 criterion 2 (part): footnoteRestart perPageSection restarts the marks at a section break', () => {
  const brk = { type: 'section_break', attrs: { id: nid('s'), pageSetup: 'ps1' } };
  const twoSections = (): J[] => [
    para('One.', {}, [footnote('A.')]),
    brk,
    para('Two.', {}, [footnote('B.')]),
  ];

  /** The marks printed by the two footnotes, in order. */
  const marks = (main: string): string[] =>
    [...main.matchAll(/\\DEfnmark\{\d+\}\{\d+\}\{([^}]*)\}/g)].map((m) => m[1]!);

  it('restarts at 1 after the section break when footnoteRestart is perPageSection', async () => {
    const bundle = await run(
      doc(twoSections(), { settings: { footnoteRestart: 'perPageSection' } }),
    );
    expect(marks(bundle.files['main.tex']!)).toEqual(['1', '1']);
  });

  it('counts through the body when footnoteRestart is continuous', async () => {
    const bundle = await run(doc(twoSections(), { settings: { footnoteRestart: 'continuous' } }));
    expect(marks(bundle.files['main.tex']!)).toEqual(['1', '2']);
  });
});

describe('EXP-029 criterion 2 (part): the mark follows settings.footnoteFormat', () => {
  it('prints the footnote mark in the format of settings.footnoteFormat (lowerRoman gives i)', async () => {
    const body = para('Body.', {}, [footnote('Note text.')]);
    const bundle = await run(doc([body], { settings: { footnoteFormat: 'lowerRoman' } }));
    expect(bundle.files['main.tex']!).toMatch(/\\DEfnmark\{\d+\}\{\d+\}\{i\}/);
  });
});
