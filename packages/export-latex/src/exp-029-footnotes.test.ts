/**
 * Footnotes (Node.js only): EXP-029 criterion 4 (a one-paragraph footnote is set in the
 * FootnoteText style) and the mark format of criterion 2 (settings.footnoteFormat). The tests read
 * main.tex and styles.tex of the converter's bundle; nothing compiles, so the PDF is not inspected.
 * Criterion 1, the converter's half: a footnote in a paragraph of the body flow is written as
 * \DEfn, which the class sets with \footnote; in a table cell, a caption and a heading the mark
 * (\DEfnmark, \footnotemark) and the text (\DEfntext, \footnotetext) are written apart. The compile
 * half is `exp-029-footnote-direct.compile.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/** The body of the style macro named by `\DEfn{offset}{n}{mark}{<macro>...`, from styles.tex. */
function footnoteStyleBody(main: string, styles: string): string {
  const name = /\\DEfn\{\d+\}\{\d+\}\{[^}]*\}\{(\\DES[a-zA-Z]+)/.exec(main)?.[1];
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
    [...main.matchAll(/\\DEfn\{\d+\}\{\d+\}\{([^}]*)\}/g)].map((m) => m[1]!);

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
    expect(bundle.files['main.tex']!).toMatch(/\\DEfn\{\d+\}\{\d+\}\{i\}/);
  });
});

describe('EXP-029 criterion 1: \\footnote where LaTeX allows it, mark and text apart elsewhere', () => {
  const cls = readFileSync(fileURLToPath(new URL('../class/docedit.cls', import.meta.url)), 'utf8');
  /** The definition of a class macro, up to the next blank line. */
  const macro = (name: string): string => {
    const at = cls.indexOf(`\\newcommand\\${name}[`);
    if (at < 0) throw new Error(`no ${name} in the class`);
    return cls.slice(at, cls.indexOf('\n\n', at));
  };
  const heading = (text: string, extra: unknown[]): J => para(text, { style: 'Heading1' }, extra);
  const headingStyle = style('Heading1', { outlineLevel: 1 });
  const table = (cell: J): J => ({
    type: 'table',
    attrs: { id: nid('t'), grid: [4320] },
    content: [
      {
        type: 'table_row',
        attrs: { id: nid('r') },
        content: [{ type: 'table_cell', attrs: { id: nid('c') }, content: [cell] }],
      },
    ],
  });
  const count = (main: string, name: string): number =>
    [...main.matchAll(new RegExp(`\\\\${name}\\{`, 'g'))].length;

  it('writes a footnote of a body paragraph as \\DEfn, with no separate mark or text', async () => {
    const main = (await run(doc([para('Body.', {}, [footnote('Direct note.')])]))).files[
      'main.tex'
    ]!;
    expect(count(main, 'DEfn')).toBe(1);
    expect(count(main, 'DEfnmark')).toBe(0);
    expect(count(main, 'DEfntext')).toBe(0);
    expect(main).toMatch(/\\DEfn\{\d+\}\{\d+\}\{1\}\{[^]*Direct note\./);
  });

  it('writes the mark and the text apart in a table cell, the text right after the mark', async () => {
    const main = (await run(doc([table(para('Cell.', {}, [footnote('Cell note.')]))]))).files[
      'main.tex'
    ]!;
    expect(count(main, 'DEfn')).toBe(0);
    expect(count(main, 'DEfnmark')).toBe(1);
    expect(count(main, 'DEfntext')).toBe(1);
    expect(main.indexOf('\\DEfnmark{')).toBeLessThan(main.indexOf('\\DEfntext{'));
  });

  it('writes the mark in a heading and its text after the heading, outside its argument', async () => {
    const body = heading('Title', [footnote('Heading note.')]);
    const bundle = await run(doc([body, para('After.')], { styles: [headingStyle] }));
    const main = bundle.files['main.tex']!;
    expect(count(main, 'DEfn')).toBe(0);
    expect(count(main, 'DEfnmark')).toBe(1);
    const text = main.split('\n').find((l) => l.startsWith('\\DEfntext{'));
    expect(text, 'the footnote text is a line of its own, after the heading').toBeDefined();
    expect(main.indexOf('\\DEfnmark{')).toBeLessThan(main.indexOf('\n\\DEfntext{'));
  });

  it('keeps the marks counting through both forms', async () => {
    const body = [
      para('One.', {}, [footnote('A.')]),
      table(para('Two.', {}, [footnote('B.')])),
      para('Three.', {}, [footnote('C.')]),
    ];
    const main = (await run(doc(body))).files['main.tex']!;
    const marks = [...main.matchAll(/\\DEfn(?:mark)?\{\d+\}\{\d+\}\{([^}]*)\}/g)].map((m) => m[1]);
    expect(marks).toEqual(['1', '2', '3']);
  });

  it('sets \\DEfn with \\footnote, and \\DEfnmark and \\DEfntext with \\footnotemark and \\footnotetext', () => {
    expect(macro('DEfn')).toMatch(/\\footnote\{/);
    expect(macro('DEfn')).not.toMatch(/\\footnotemark|\\footnotetext/);
    expect(macro('DEfnmark')).toMatch(/\\footnotemark/);
    expect(macro('DEfntext')).toMatch(/\\footnotetext\[/);
  });
});
