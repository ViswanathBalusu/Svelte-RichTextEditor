/**
 * EXP-013 criterion 5 (Node.js only): the values a flattened style macro writes in `styles.tex`
 * equal the values the model's cascade resolves for a paragraph of that style (03 §6).
 *
 * The expected values are not taken from the converter. They come from `resolveParagraph` and
 * `resolveRun` in `@docedit/model`, and from the model's unit convention (`twipsToBp`). The macro
 * is read back by parsing its body, so the test checks what reaches TeX, not what the converter
 * intended to write.
 *
 * Scope: the setters that the style macro carries (font size, weight and shape, alignment, the
 * three indents, widow control, keep lines and the line rule). Spacing before and after, keep with
 * next, page break before and contextual spacing are not written into the macro: blocks.ts applies
 * them from the same resolved paragraph (flow gaps), so they are not compared here.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  resolveParagraph,
  resolveRun,
  styleTable,
  twipsToBp,
  type CdmEnvelope,
  type TreeNode,
} from '@docedit/model';
import { doc, para, run, blockLines, type J } from '../test/docs.ts';

const ALIGN_CODE: Record<string, string> = { justify: '0', start: '1', center: '2', end: '3' };

/** The body of the style macro that a paragraph of `pid` uses, from styles.tex. */
function macroBodyUsedBy(lines: string[], styles: string): string {
  const name = /\\(DES[a-z]+)/.exec(lines.join('\n'))?.[1];
  if (!name) throw new Error('the paragraph writes no style macro');
  const def = styles.split('\n').find((l) => l.startsWith(`\\def\\${name}{`));
  if (!def) throw new Error(`no definition of ${name}`);
  return def.slice(`\\def\\${name}{`.length, -1);
}

/** The value written after a setter name, for example `\DEsz{12bp}` gives `12bp`. */
function setterValue(body: string, name: string): string | undefined {
  const at = body.indexOf(`\\${name}{`);
  if (at < 0) return undefined;
  const start = at + name.length + 2;
  const end = body.indexOf('}', start);
  return body.slice(start, end);
}

const twips = (min: number, max: number) => fc.integer({ min, max });

const arbCase = fc.record({
  fontSize: twips(20, 2000),
  bold: fc.boolean(),
  italic: fc.boolean(),
  smallCaps: fc.boolean(),
  align: fc.constantFrom('start', 'center', 'end', 'justify'),
  indentLeft: twips(0, 3000),
  indentRight: twips(0, 3000),
  indentFirstLine: twips(0, 1000),
  widowControl: fc.boolean(),
  keepLines: fc.boolean(),
  lineRule: fc.constantFrom('multiple', 'exact', 'atLeast'),
  lineSpacing: twips(1, 2000),
  parentFontSize: twips(20, 2000),
  parentItalic: fc.boolean(),
  parentAlign: fc.constantFrom('start', 'center', 'end', 'justify'),
});

describe('EXP-013 a flattened style equals the cascade (criterion 5)', () => {
  it('writes the model cascade values for every setter the style macro carries', async () => {
    await fc.assert(
      fc.asyncProperty(arbCase, async (c) => {
        const styles: J[] = [
          {
            type: 'style_def',
            attrs: {
              id: 'Parent',
              kind: 'paragraph',
              name: 'Parent',
              builtIn: false,
              fontSize: c.parentFontSize,
              italic: c.parentItalic,
              align: c.parentAlign,
            },
          },
          {
            type: 'style_def',
            attrs: {
              id: 'Leaf',
              kind: 'paragraph',
              name: 'Leaf',
              builtIn: false,
              basedOn: 'Parent',
              fontSize: c.fontSize,
              bold: c.bold,
              italic: c.italic,
              smallCaps: c.smallCaps,
              align: c.align,
              indentLeft: c.indentLeft,
              indentRight: c.indentRight,
              indentFirstLine: c.indentFirstLine,
              widowControl: c.widowControl,
              keepLines: c.keepLines,
              lineRule: c.lineRule,
              lineSpacing: c.lineSpacing,
            },
          },
        ];
        const pid = 'pLeaf0000000001';
        const env: CdmEnvelope = doc([para('Leaf text.', { id: pid, style: 'Leaf' })], { styles });
        const b = await run(env);
        const table = styleTable(env.doc as unknown as TreeNode);
        const resolved = resolveParagraph(table, { style: 'Leaf' });
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        const p = resolved.value;
        const r = resolveRun(table, p, []);
        expect(r.ok).toBe(true);
        if (!r.ok) return;

        // The model applied the generated values, so the comparison is not vacuous.
        expect(r.value.fontSize).toBe(c.fontSize);
        expect(p.properties.align).toBe(c.align);

        const body = macroBodyUsedBy(blockLines(b, pid), b.files['styles.tex']!);
        expect(setterValue(body, 'DEsz')).toBe(twipsToBp(r.value.fontSize));
        expect(setterValue(body, 'DEbf')).toBe(r.value.bold ? '1' : '0');
        expect(setterValue(body, 'DEit')).toBe(r.value.italic ? '1' : '0');
        expect(setterValue(body, 'DEsc')).toBe(r.value.smallCaps ? '1' : '0');
        expect(setterValue(body, 'DEal')).toBe(ALIGN_CODE[p.properties.align]);
        expect(setterValue(body, 'DEil')).toBe(twipsToBp(p.properties.indentLeft));
        expect(setterValue(body, 'DEir')).toBe(twipsToBp(p.properties.indentRight));
        expect(setterValue(body, 'DEif')).toBe(twipsToBp(p.properties.indentFirstLine));
        expect(setterValue(body, 'DEwc')).toBe(p.properties.widowControl ? '1' : '0');
        expect(setterValue(body, 'DEkl')).toBe(p.properties.keepLines ? '1' : '0');
        const lineName =
          p.properties.lineRule === 'exact'
            ? 'DElse'
            : p.properties.lineRule === 'atLeast'
              ? 'DElsa'
              : 'DElsm';
        expect(setterValue(body, lineName)).toBe(
          String(Math.max(1, Math.min(31680, Math.trunc(p.properties.lineSpacing)))),
        );
      }),
      { numRuns: 40 },
    );
  });
});
