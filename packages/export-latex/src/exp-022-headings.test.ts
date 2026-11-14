/**
 * Headings and bookmarks (Node.js only): EXP-022 criteria 2 (bookmark text), 3 (literal label) and
 * 4 (levels 1 to 9, converter side). The tests read main.tex of the converter's bundle through
 * `blockLines`; nothing compiles, so the PDF bookmarks and the rendered levels are not inspected.
 * Criterion 1 (bookmark for each heading in the PDF) needs a compile; criterion 2 also covers caption
 * lists and table of contents entries, and EXP-023 (the table of contents) is not built.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blockLines, decodeStrings, doc, para, run, type J } from '../test/docs.ts';

const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;
const CLASS = readFileSync(fileURLToPath(new URL('../class/docedit.cls', import.meta.url)), 'utf8');

/** A paragraph style with an outline level, based on Normal. */
function heading(id: string, level: number): J {
  return {
    type: 'style_def',
    attrs: {
      id,
      kind: 'paragraph',
      name: `Heading ${level}`,
      builtIn: true,
      outlineLevel: level,
      bold: true,
    },
  };
}

/** A heading paragraph in the style `style`, with optional numbering. */
function headingPara(content: string, style: string, extra: J = {}, marks: J[] = []): J {
  const p = para('', { style, ...extra });
  (p as { content: J[] }).content = [
    { type: 'text', text: content, ...(marks.length > 0 ? { marks } : {}) },
  ];
  return p;
}

/** The `\DEh` line of a heading: its first line of main.tex. */
function headingLine(lines: string[]): string {
  const line = lines.find((l) => l.startsWith('\\DEh{'));
  if (line === undefined) throw new Error('the block is not a heading');
  return line;
}

/** The bookmark text of a heading, decoded from its first `\DEstr`. */
function bookmarkOf(line: string): string {
  const m = /\\DEstr\{[0-9A-F]*\}/.exec(line);
  if (m === null) throw new Error(`no bookmark string in ${line}`);
  return decodeStrings(m[0]);
}

/** The literal label of a heading: the fifth argument of `\DEh`. */
function labelOf(line: string): string {
  const m = /\\DEh\{\d+\}\{\d\}\{.*\}\{\\DEstr\{[0-9A-F]*\}\}\{(.*)\}\{\d\}\{%$/.exec(line);
  if (m === null) throw new Error(`no label in ${line}`);
  return m[1]!;
}

describe('EXP-022 criterion 2: the bookmark text is the heading text in plain form, through pdfString', () => {
  it('writes the plain text of a formatted heading, with its special characters, as the bookmark string', async () => {
    const h = headingPara('Head & 50% #1 \\ _x_', 'H1', {}, [{ type: 'bold' }]);
    const bundle = await run(doc([h], { styles: [heading('H1', 1)] }));
    expect(bookmarkOf(headingLine(blockLines(bundle, idOf(h))))).toBe('Head & 50% #1 \\ _x_');
  });

  it('leaves a hidden run out of the bookmark string', async () => {
    const h = headingPara('shown', 'H1');
    (h as { content: J[] }).content.push({
      type: 'text',
      text: ' secret',
      marks: [{ type: 'hidden' }],
    });
    const bundle = await run(doc([h], { styles: [heading('H1', 1)] }));
    expect(bookmarkOf(headingLine(blockLines(bundle, idOf(h))))).toBe('shown');
  });
});

describe('EXP-022 criterion 3: a numbered heading carries the literal label of the shared algorithm', () => {
  it('prints the label as the heading label and puts it in the bookmark text before the heading text', async () => {
    const h = headingPara('Introduction', 'H1', {
      numbering: { numberingId: 'hn', level: 0, listId: 'hl' },
    });
    const bundle = await run(
      doc([h], {
        styles: [heading('H1', 1)],
        numberings: [
          {
            type: 'numbering_def',
            attrs: { id: 'hn', levels: [{ format: 'decimal', text: '%1.', start: 1 }] },
          },
        ],
      }),
    );
    const line = headingLine(blockLines(bundle, idOf(h)));
    expect(labelOf(line)).toBe('1.');
    expect(bookmarkOf(line)).toBe('1. Introduction');
  });
});

describe('EXP-022 criterion 4 (converter side): each heading level from 1 to 9 is set at its level', () => {
  it('writes \\DEh with the outline level of the style for every level from 1 to 9', async () => {
    const styles = Array.from({ length: 9 }, (_v, i) => heading(`H${i + 1}`, i + 1));
    const paras = styles.map((s, i) => headingPara(`level ${i + 1}`, `H${i + 1}`));
    const bundle = await run(doc(paras, { styles }));
    for (let i = 0; i < 9; i++) {
      expect(headingLine(blockLines(bundle, idOf(paras[i]!)))).toMatch(
        new RegExp(`^\\\\DEh\\{\\d+\\}\\{${i + 1}\\}\\{`),
      );
    }
  });

  it('clamps an outline level above 9 to 9 and never writes a level below 1', async () => {
    const styles = [heading('High', 12)];
    const h = headingPara('deep', 'High');
    const bundle = await run(doc([h], { styles }));
    expect(headingLine(blockLines(bundle, idOf(h)))).toMatch(/^\\DEh\{\d+\}\{9\}\{/);
  });
});

describe('EXP-022 criterion 1 (source side): headings use the kernel sectioning commands', () => {
  it('builds \\DEh from the class sectioning commands, so bookmarks and tagging come from the kernel', () => {
    expect(CLASS).toMatch(/\\renewcommand\\section\{\\@startsection\{section\}\{1\}/);
    expect(CLASS).toMatch(/\\renewcommand\\subsection\{\\@startsection\{subsection\}\{2\}/);
    expect(CLASS).toMatch(/\\def\\DE@defsec#1#2/);
  });
});
