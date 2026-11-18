/**
 * Paragraph indents under the formatting cascade of 03 §6 (Node.js only): EXP-020 criterion 1,
 * the numbering-level leg. The order is style defaults, table style, paragraph style chain (layer 3),
 * numbering level (layer 4), direct attributes (layer 5), as in Word (owner decision 9, 2026-11-15). The model resolves it
 * (`resolveParagraph`, ADR 0032); the converter writes the resolved values, so these tests read
 * the setters of main.tex and styles.tex. Nothing compiles here.
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, para, run, type J } from '../test/docs.ts';
import { dimen } from './emit.ts';

const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;
const style = (id: string, attrs: J): J => ({
  type: 'style_def',
  attrs: { id, kind: 'paragraph', name: id, ...attrs },
});
const numbering = (id: string, levels: J[]): J => ({
  type: 'numbering_def',
  attrs: { id, levels },
});

/** The argument of the last `\name{...}` written in `text`, or undefined. */
function lastArg(text: string, name: string): string | undefined {
  const at = text.lastIndexOf(`\\${name}{`);
  if (at < 0) return undefined;
  const start = at + name.length + 2;
  return text.slice(start, text.indexOf('}', start));
}

/** The body of the style macro that the paragraph's lines call first, from styles.tex. */
function macroBody(lines: string[], styles: string): string {
  const name = /\\(DES[a-zA-Z]+)/.exec(lines.join('\n'))?.[1];
  if (!name) throw new Error('the paragraph writes no style macro');
  const def = styles.split('\n').find((l) => l.startsWith(`\\def\\${name}{`));
  if (!def) throw new Error(`no definition of ${name}`);
  return def.slice(`\\def\\${name}{`.length, -1);
}

/** The effective argument of a paragraph setter: its own setter, else the style macro's. */
function effective(lines: string[], styles: string, name: string): string | undefined {
  return lastArg(lines.join('\n'), name) ?? lastArg(macroBody(lines, styles), name);
}

/** A numbering whose level 0 has the given indents, in twips. */
const withLevel = (indentLeft: number, hanging: number): J[] => [
  numbering('n', [{ format: 'decimal', text: '%1.', start: 1, indentLeft, hanging }]),
];

describe('EXP-020 criterion 1 (numbering-level leg): the level indents apply when nothing else sets them', () => {
  it('gives a numbered paragraph the level indentLeft and the negative hanging indent of its level', async () => {
    const p = para('Item.', {
      style: 'Body',
      numbering: { numberingId: 'n', level: 0, listId: 'L1' },
    });
    const bundle = await run(
      doc([p], { styles: [style('Body', { fontSize: 2400 })], numberings: withLevel(720, 360) }),
    );
    const lines = blockLines(bundle, idOf(p));
    const styles = bundle.files['styles.tex']!;
    expect(effective(lines, styles, 'DEil')).toBe(String(dimen(720)));
    expect(effective(lines, styles, 'DEif')).toBe(`-${dimen(360)}`);
  });

  it('gives the level indentLeft over the paragraph style indentLeft (the level is layer 4, above the style chain)', async () => {
    const p = para('Item.', {
      style: 'Body',
      numbering: { numberingId: 'n', level: 0, listId: 'L1' },
    });
    const bundle = await run(
      doc([p], { styles: [style('Body', { indentLeft: 1440 })], numberings: withLevel(720, 360) }),
    );
    const lines = blockLines(bundle, idOf(p));
    expect(effective(lines, bundle.files['styles.tex']!, 'DEil')).toBe(String(dimen(720)));
  });

  it('gives a direct indentLeft over both the style and the level', async () => {
    const p = para('Item.', {
      style: 'Body',
      numbering: { numberingId: 'n', level: 0, listId: 'L1' },
      indentLeft: 0,
    });
    const bundle = await run(
      doc([p], { styles: [style('Body', { indentLeft: 1440 })], numberings: withLevel(720, 360) }),
    );
    const lines = blockLines(bundle, idOf(p));
    expect(effective(lines, bundle.files['styles.tex']!, 'DEil')).toBe(String(dimen(0)));
  });
});
