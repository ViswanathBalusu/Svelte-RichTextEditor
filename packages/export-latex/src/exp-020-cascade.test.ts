/**
 * Paragraph styles from the formatting cascade (Node.js only): EXP-020 criteria 1, 3, 4 and 5.
 * Criterion 2 (borders and shading drawn around and behind a paragraph) is not built: the class
 * does not draw paragraph borders yet, and it warns about shading (props.ts). Nothing compiles here:
 * the tests read main.tex, styles.tex and the diagnostics of the converter's bundle.
 *
 * Paragraph attributes set paragraph-level setters (`\DEal`, `\DEil`, ...). Font size and family
 * are run properties: a text run takes them from a mark, and they print in its `\DEfont` macro.
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, para, run, type J } from '../test/docs.ts';
import { dimen } from './emit.ts';

const SIZE = { min: 20, max: 32760 };
const LEN = { min: 0, max: 31680 };
const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;
const style = (id: string, attrs: J): J => ({
  type: 'style_def',
  attrs: { id, kind: 'paragraph', name: id, ...attrs },
});
const textRun = (text: string, marks: J[] = []): J => ({ type: 'text', text, marks });

/** The argument of the last `\name{...}` written in `text`, or undefined. */
function lastArg(text: string, name: string): string | undefined {
  const at = text.lastIndexOf(`\\${name}{`);
  if (at < 0) return undefined;
  const start = at + name.length + 2;
  return text.slice(start, text.indexOf('}', start));
}

/** The body of the style macro that a paragraph's lines call first, from styles.tex. */
function macroBody(lines: string[], styles: string): string {
  const name = /\\(DES[a-zA-Z]+)/.exec(lines.join('\n'))?.[1];
  if (!name) throw new Error('the paragraph writes no style macro');
  const def = styles.split('\n').find((l) => l.startsWith(`\\def\\${name}{`));
  if (!def) throw new Error(`no definition of ${name}`);
  return def.slice(`\\def\\${name}{`.length, -1);
}

/** The effective argument of a paragraph setter: its own setter, else the style macro's. */
function effective(lines: string[], styles: string, name: string): string | undefined {
  const own = lastArg(lines.join('\n'), name);
  return own ?? lastArg(macroBody(lines, styles), name);
}

describe('EXP-020 criterion 1: direct attributes and style attributes follow the cascade', () => {
  const styles = [
    style('Body', {
      fontSize: 2400,
      align: 'center',
      indentLeft: 720,
      indentRight: 360,
      lineRule: 'multiple',
      lineSpacing: 1150,
      keepLines: true,
      widowControl: true,
    }),
  ];

  it('gives a direct paragraph value over the style value, and the style value where there is none', async () => {
    const p = para(
      'Direct.',
      { style: 'Body', align: 'end', indentLeft: 0, keepLines: false, widowControl: false },
      [],
    );
    const q = para('Inherited.', { style: 'Body' });
    const bundle = await run(doc([p, q], { styles }));
    const pLines = blockLines(bundle, idOf(p));
    const qLines = blockLines(bundle, idOf(q));
    const styleFile = bundle.files['styles.tex']!;

    expect(effective(pLines, styleFile, 'DEal')).toBe('3');
    expect(effective(qLines, styleFile, 'DEal')).toBe('2');
    expect(effective(pLines, styleFile, 'DEil')).toBe(String(dimen(0, LEN)));
    expect(effective(qLines, styleFile, 'DEil')).toBe(String(dimen(720, LEN)));
    expect(effective(pLines, styleFile, 'DEir')).toBe(String(dimen(360, LEN)));
    expect(effective(pLines, styleFile, 'DEkl')).toBe('0');
    expect(effective(qLines, styleFile, 'DEkl')).toBe('1');
    expect(effective(pLines, styleFile, 'DEwc')).toBe('0');
    expect(effective(qLines, styleFile, 'DEwc')).toBe('1');
    expect(effective(qLines, styleFile, 'DElsm')).toBe('1150');
  });

  it('gives a run a direct font size over the style size, and the style size where the run has none', async () => {
    const p = para('', { style: 'Body' }, [
      textRun('Direct.', [{ type: 'fontSize', attrs: { value: 1800 } }]),
    ]);
    const q = para('Inherited.', { style: 'Body' });
    const bundle = await run(doc([p, q], { styles }));
    expect(blockLines(bundle, idOf(p)).join('\n')).toContain(`{${dimen(1800, SIZE)}}`);
    expect(effective(blockLines(bundle, idOf(q)), bundle.files['styles.tex']!, 'DEsz')).toBe(
      String(dimen(2400, SIZE)),
    );
  });

  it('writes keepNext from the style and pageBreakBefore from the paragraph', async () => {
    const keep = [style('Keep', { keepNext: true })];
    const k = para('Keep with next.', { style: 'Keep' });
    const b = para('Starts a page.', { pageBreakBefore: true });
    const bundle = await run(doc([k, b], { styles: keep }));
    expect(bundle.files['main.tex']!).toContain('\\DEkeep');
    expect(blockLines(bundle, idOf(b)).join('\n')).toContain('\\DEpb');
  });

  it('writes the gap between two paragraphs as the larger of the first spaceAfter and the second spaceBefore', async () => {
    const keep = [style('Keep', { spaceAfter: 60, spaceBefore: 0 })];
    const k = para('First.', { style: 'Keep' });
    const b = para('Second.', { spaceBefore: 120, spaceAfter: 0 });
    const bundle = await run(doc([k, b], { styles: keep }));
    expect(bundle.files['main.tex']!).toContain(`\\DEgap{${dimen(120, LEN)}}`);
  });
});

describe('EXP-020 criterion 1: the font family follows the style chain (basedOn)', () => {
  it('gives a style the family of the style it is based on, and not the default family', async () => {
    const styles = [
      style('Base', { fontFamily: 'Noto Sans' }),
      style('Child', { basedOn: 'Base', fontSize: 1400 }),
    ];
    const child = para('Child.', { style: 'Child' });
    const plain = para('Plain.', {});
    const bundle = await run(doc([child, plain], { styles }));
    const styleFile = bundle.files['styles.tex']!;
    const famChild = effective(blockLines(bundle, idOf(child)), styleFile, 'DEfam');
    const famPlain = effective(blockLines(bundle, idOf(plain)), styleFile, 'DEfam');
    expect(famChild).toBeDefined();
    expect(famChild).not.toBe(famPlain);
    expect(effective(blockLines(bundle, idOf(child)), styleFile, 'DEsz')).toBe(
      String(dimen(1400, SIZE)),
    );
  });
});

describe('EXP-020 criterion 3: a run mark with value false switches off a property the style switches on', () => {
  const styles = [style('Heavy', { bold: true })];

  it('prints a run with bold value false in the medium weight, and the same run without the mark in bold', async () => {
    const off = para('', { style: 'Heavy' }, [
      textRun('word', [{ type: 'bold', attrs: { value: false } }]),
    ]);
    const on = para('', { style: 'Heavy' }, [textRun('word')]);
    const bundle = await run(doc([off, on], { styles }));
    expect(blockLines(bundle, idOf(off)).join('\n')).toMatch(/\\DEfont\{\d+\}\{[^}]+\}\{m\}\{n\}/);
    // The run has no mark of its own: its weight is the style's, bold, set in the style macro.
    expect(effective(blockLines(bundle, idOf(on)), bundle.files['styles.tex']!, 'DEbf')).toBe('1');
  });
});

describe('EXP-020 criterion 4: an unknown fontFamily uses the fallback and a diagnostic names it', () => {
  it('reports font_family_missing with the family name on the paragraph, and sets the default family', async () => {
    const missing = para('', {}, [
      textRun('Text.', [{ type: 'fontFamily', attrs: { value: 'Nonexistent Serif Display' } }]),
    ]);
    const known = para('Text.', {});
    const bundle = await run(doc([missing, known]));
    const diag = bundle.diagnostics.find(
      (d) => d.code === 'font_family_missing' && d.blockId === idOf(missing),
    );
    expect(diag).toBeDefined();
    expect(diag?.message).toContain('Nonexistent Serif Display');
    expect(blockLines(bundle, idOf(missing)).join('\n')).toMatch(/\\DEfont\{1\}/);
  });
});

describe('EXP-020 criterion 5: a paragraph style in a table overrides the table style', () => {
  const styles = [
    style('Cell', { fontSize: 2400 }),
    { type: 'style_def', attrs: { id: 'Grid', kind: 'table', name: 'Grid', fontSize: 1000 } },
  ];

  /** A one-cell table with table style Grid whose cell holds `inCell`. */
  const table = (inCell: J): J => ({
    type: 'table',
    attrs: { id: 'tbl0000000000001', grid: [2880], style: 'Grid' },
    content: [
      {
        type: 'table_row',
        attrs: { id: 'row0000000000001' },
        content: [{ type: 'table_cell', attrs: { id: 'cel0000000000001' }, content: [inCell] }],
      },
    ],
  });

  it('gives a cell paragraph with a paragraph style the paragraph style size, and the table size to one with no style', async () => {
    const styled = para('In cell.', { style: 'Cell' });
    const plain = para('In cell.', {});
    const withStyle = await run(doc([table(styled)], { styles }));
    const withoutStyle = await run(doc([table(plain)], { styles }));
    expect(
      effective(blockLines(withStyle, idOf(styled)), withStyle.files['styles.tex']!, 'DEsz'),
    ).toBe(String(dimen(2400, SIZE)));
    expect(
      effective(blockLines(withoutStyle, idOf(plain)), withoutStyle.files['styles.tex']!, 'DEsz'),
    ).toBe(String(dimen(1000, SIZE)));
  });
});
