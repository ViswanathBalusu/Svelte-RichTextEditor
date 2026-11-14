/**
 * Numbered lists with literal labels (Node.js only): EXP-024 criteria 1 to 5. The labels come from
 * the shared algorithm (`computeLabels` in @docedit/model, CDM-042), so the comparison with the
 * editor is the comparison with that one function. Nothing here compiles: the tests read main.tex
 * of the converter's bundle through `blockLines`, so the printed PDF is not inspected.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeLabels, type TreeNode } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { blockLines, codes, doc, para, run, type J } from '../test/docs.ts';
import { tableOf } from '../test/suggestions.ts';

const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;

/** A numbering definition with the given levels. */
const numbering = (id: string, levels: J[]): J => ({
  type: 'numbering_def',
  attrs: { id, levels },
});

/** A decimal outline of n levels: level k prints %1 through %k+1, joined by full stops. */
function outline(n: number): J[] {
  return Array.from({ length: n }, (_, i) => ({
    format: 'decimal',
    text: `${Array.from({ length: i + 1 }, (_v, k) => `%${k + 1}`).join('.')}.`,
    start: 1,
  }));
}

/** A list item of the definition `numberingId` at `level` in the list `listId`. */
function item(content: string, level: number, listId: string, numberingId = 'n', extra: J = {}): J {
  return para(content, { numbering: { numberingId, level, listId }, ...extra });
}

/** The label that main.tex prints for a list item, read from its `\DEli` line. */
function labelOf(lines: string[]): string {
  const line = lines.find((l) => l.includes('\\DEli{'));
  if (line === undefined) throw new Error('the block is not a list item');
  const m = /\\DEli\{\d+\}\{.*\}\{(.*)\}\{\d\}\{%$/.exec(line);
  if (m === null) throw new Error(`no label in ${line}`);
  return m[1]!;
}

/** The label line's alignment code, the last argument of `\DEli`. */
function alignOf(lines: string[]): string {
  const line = lines.find((l) => l.includes('\\DEli{'));
  const m = /\\DEli\{\d+\}\{.*\}\{.*\}\{(\d)\}\{%$/.exec(line ?? '');
  if (m === null) throw new Error('no alignment code');
  return m[1]!;
}

/** The label of a block as the editor computes it, through the shared algorithm. */
function editorLabel(envelope: { doc: unknown }, id: string): string {
  return computeLabels(envelope.doc as TreeNode).lists.get(id)?.text ?? '';
}

const MAIN = 'main.tex';

describe("EXP-024 criterion 1: labels are the shared algorithm's literal text, with no LaTeX counter", () => {
  it('prints each label as text in the \\DEli macro and uses no counter command for list numbers', async () => {
    const a = item('first', 0, 'listA');
    const b = item('second', 0, 'listA');
    const c = item('sub', 1, 'listA');
    const bundle = await run(doc([a, b, c], { numberings: [numbering('n', outline(2))] }));
    expect(labelOf(blockLines(bundle, idOf(a)))).toBe('1.');
    expect(labelOf(blockLines(bundle, idOf(b)))).toBe('2.');
    expect(labelOf(blockLines(bundle, idOf(c)))).toBe('2.1.');
    // No counter of the kernel or of the class produces a list number in the output.
    expect(bundle.files[MAIN]!).not.toMatch(
      /\\(arabic|alph|Alph|roman|Roman|value|the|stepcounter|refstepcounter|setcounter|addtocounter)\b/,
    );
  });

  it('draws the list macros from the house class, which defines them', () => {
    const cls = readFileSync(
      fileURLToPath(new URL('../class/docedit.cls', import.meta.url)),
      'utf8',
    );
    expect(cls).toMatch(/\\newenvironment\{DElist\}/);
    expect(cls).toMatch(/\\newcommand\\DEli\[5\]/);
  });
});

describe("EXP-024 criterion 2: labels equal the editor's for skipped levels, a table between items, nine levels and restarts", () => {
  it('matches computeLabels for skipped levels and a table between two items', async () => {
    const top = item('top', 0, 'L');
    const skipped = item('skipped a level', 2, 'L');
    const table = tableOf([{ cells: ['inside the table'] }]);
    const after = item('after the table', 1, 'L');
    const envelope = doc([top, skipped, table, after], {
      numberings: [numbering('n', outline(3))],
    });
    const bundle = await run(envelope);
    for (const p of [top, skipped, after]) {
      expect(labelOf(blockLines(bundle, idOf(p)))).toBe(editorLabel(envelope, idOf(p)));
    }
  });

  it('matches computeLabels for nine nested levels', async () => {
    const levels = outline(9);
    const items = levels.map((_l, i) => item(`level ${i + 1}`, i, 'deep'));
    items.push(item('back to one', 0, 'deep'));
    const envelope = doc(items, { numberings: [numbering('n', levels)] });
    const bundle = await run(envelope);
    for (const p of items) {
      expect(labelOf(blockLines(bundle, idOf(p)))).toBe(editorLabel(envelope, idOf(p)));
    }
    expect(labelOf(blockLines(bundle, idOf(items[8]!)))).toBe('1.1.1.1.1.1.1.1.1.');
  });

  it('matches computeLabels for numberingRestart, restartAfter and legal numbering', async () => {
    const levels = [
      { format: 'decimal', text: '%1.', start: 1 },
      { format: 'decimal', text: '%1.%2', start: 1, legal: true, restartAfter: 0 },
      { format: 'lowerLetter', text: '(%3)', start: 1, restartAfter: 1 },
    ];
    const a = item('one', 0, 'R');
    const b = item('one sub one', 1, 'R');
    const c = item('one sub one letter a', 2, 'R');
    const d = item('restarted at four', 0, 'R', 'n', { numberingRestart: 4 });
    const e = item('after restart', 1, 'R');
    const envelope = doc([a, b, c, d, e], { numberings: [numbering('n', levels)] });
    const bundle = await run(envelope);
    for (const p of [a, b, c, d, e]) {
      expect(labelOf(blockLines(bundle, idOf(p)))).toBe(editorLabel(envelope, idOf(p)));
    }
    expect(labelOf(blockLines(bundle, idOf(d)))).toBe('4.');
  });
});

describe('EXP-024 criterion 3: two lists with one definition and different listIds number independently', () => {
  it('starts the second list at 1 while the first list keeps its count', async () => {
    const a1 = item('a1', 0, 'listA');
    const a2 = item('a2', 0, 'listA');
    const b1 = item('b1', 0, 'listB');
    const b2 = item('b2', 0, 'listB');
    const bundle = await run(doc([a1, a2, b1, b2], { numberings: [numbering('n', outline(1))] }));
    expect(labelOf(blockLines(bundle, idOf(a2)))).toBe('2.');
    expect(labelOf(blockLines(bundle, idOf(b1)))).toBe('1.');
    expect(labelOf(blockLines(bundle, idOf(b2)))).toBe('2.');
  });
});

describe('EXP-024 criterion 4: bullets come from the published list, and the stored value is never written', () => {
  it('prints a published bullet character from the table', async () => {
    const p = item('bulleted', 0, 'B', 'bul');
    const bundle = await run(
      doc([p], {
        numberings: [numbering('bul', [{ format: 'bullet', text: '', start: 1, bulletChar: '◦' }])],
      }),
    );
    expect(labelOf(blockLines(bundle, idOf(p)))).toBe('◦');
  });

  it('prints the default bullet and never the stored value when the value is not in the published list', async () => {
    const p = item('odd bullet', 0, 'B', 'odd');
    const bundle = await run(
      doc([p], {
        numberings: [numbering('odd', [{ format: 'bullet', text: '', start: 1, bulletChar: '✗' }])],
      }),
    );
    expect(labelOf(blockLines(bundle, idOf(p)))).toBe('•');
    expect(bundle.files[MAIN]!).not.toContain('✗');
    expect(codes(bundle)).toContain('enum_unknown');
  });
});

describe('EXP-024 criterion 5: indentLeft, hanging and align of a level place the label and text', () => {
  it('sets the list margin, the label indent and the hanging indent from the level', async () => {
    const p = item('indented', 0, 'I', 'ind');
    const bundle = await run(
      doc([p], {
        numberings: [
          numbering('ind', [
            { format: 'decimal', text: '%1.', start: 1, indentLeft: 720, hanging: 360 },
          ]),
        ],
      }),
    );
    const li = blockLines(bundle, idOf(p)).find((l) => l.includes('\\DEli{'))!;
    expect(li).toContain('\\DEil{36bp}\\DEif{-18bp}');
    expect(bundle.files[MAIN]!).toContain('\\begin{DElist}{36bp}');
  });

  it("writes the level's label alignment as the class code: 0 start, 1 centre, 2 end", async () => {
    const align = async (value: string): Promise<string> => {
      const p = item('aligned', 0, 'A', 'al');
      const bundle = await run(
        doc([p], {
          numberings: [
            numbering('al', [{ format: 'decimal', text: '%1.', start: 1, align: value }]),
          ],
        }),
      );
      return alignOf(blockLines(bundle, idOf(p)));
    };
    expect(await align('start')).toBe('0');
    expect(await align('center')).toBe('1');
    expect(await align('end')).toBe('2');
  });
});
