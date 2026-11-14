/**
 * EXP-044 criteria 2 and 4 (Node.js only): a colour that is not six hexadecimal digits is not
 * written and a diagnostic names its block; a lookup with no entry uses the table's fallback and
 * a diagnostic names its block. The documents come from `test/docs.ts`; nothing here compiles.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blockLines, codes, doc, nid, para, run } from '../test/docs.ts';
import type { Bundle, Diagnostic } from './index.ts';

const NOT_A_COLOUR = fc.string({ maxLength: 12 }).filter((s) => !/^#[0-9A-Fa-f]{6}$/.test(s));

/** The colour payloads the converter wrote in a block: `\DEc{...}`, `\DEcol{...}`, `\DEshade{...}`. */
function colourPayloads(lines: readonly string[]): string[] {
  return lines.flatMap((l) => [...l.matchAll(/\\DE(?:c|col|shade)\{([^}]*)\}/g)].map((m) => m[1]!));
}

function diagnosticsFor(b: Bundle, code: string, blockId: string): Diagnostic[] {
  return b.diagnostics.filter((d) => d.code === code && d.blockId === blockId);
}

describe('EXP-044 colour emitter in runs (criterion 2)', () => {
  it('never writes a colour that is not six hex digits, and names the paragraph in a diagnostic', async () => {
    await fc.assert(
      fc.asyncProperty(NOT_A_COLOUR, async (value) => {
        const id = nid('p');
        const p = {
          type: 'paragraph',
          attrs: { id },
          content: [{ type: 'text', text: 'Text', marks: [{ type: 'color', attrs: { value } }] }],
        };
        const b = await run(doc([p]));
        expect(diagnosticsFor(b, 'colour_invalid', id).length).toBeGreaterThan(0);
        for (const payload of colourPayloads(blockLines(b, id)))
          expect(payload).toMatch(/^[0-9A-F]{6}$/);
      }),
      { numRuns: 200 },
    );
  });

  it('gives no colour diagnostic for a valid colour or for no colour', async () => {
    const id = nid('p');
    const p = {
      type: 'paragraph',
      attrs: { id },
      content: [
        { type: 'text', text: 'Text', marks: [{ type: 'color', attrs: { value: '#1F5FAD' } }] },
      ],
    };
    const b = await run(doc([p, para('No colour.')]));
    expect(codes(b)).not.toContain('colour_invalid');
    expect(colourPayloads(blockLines(b, id))).toContain('1F5FAD');
  });
});

describe('EXP-044 colour emitter in table cells (criterion 2)', () => {
  it('writes no shading for a cell colour that is not six hex digits, and names the cell', async () => {
    const cell = nid('c');
    const table = {
      type: 'table',
      attrs: { id: nid('t'), grid: [2880] },
      content: [
        {
          type: 'table_row',
          attrs: { id: nid('r') },
          content: [
            {
              type: 'table_cell',
              attrs: { id: cell, shading: { fill: 'red' } },
              content: [para('Cell.')],
            },
          ],
        },
      ],
    };
    const b = await run(doc([table]));
    expect(diagnosticsFor(b, 'colour_invalid', cell).length).toBe(1);
    expect(b.files['main.tex']).not.toContain('\\cellcolor');
    expect(b.files['main.tex']).not.toContain('RED');
  });
});

describe('EXP-044 enumeration lookup (criterion 4)', () => {
  it('uses the default alignment for an unknown value and names the paragraph', async () => {
    const id = nid('p');
    const b = await run(
      doc([
        {
          type: 'paragraph',
          attrs: { id, align: 'sideways' },
          content: [{ type: 'text', text: 'Text' }],
        },
      ]),
    );
    expect(diagnosticsFor(b, 'enum_unknown', id).length).toBe(1);
    expect(blockLines(b, id).join('\n')).toContain('\\DEal{1}');
    expect(b.files['main.tex']).not.toContain('sideways');
  });

  it('uses yellow for an unknown highlight and names the paragraph', async () => {
    const id = nid('p');
    const p = {
      type: 'paragraph',
      attrs: { id },
      content: [
        {
          type: 'text',
          text: 'Text',
          marks: [{ type: 'highlight', attrs: { value: 'octarine' } }],
        },
      ],
    };
    const b = await run(doc([p]));
    expect(diagnosticsFor(b, 'enum_unknown', id).length).toBe(1);
    // The class's \DEhl takes the colour name as its first argument (docedit.cls, \highLight).
    expect(blockLines(b, id).join('\n')).toContain('\\DEhl{DEhlyellow}{');
  });

  it('gives no enumeration diagnostic when the value is absent or known', async () => {
    const b = await run(doc([para('Plain.', { align: 'center' })]));
    expect(codes(b)).not.toContain('enum_unknown');
  });

  it('never writes an unknown value into the bundle, for any value (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 16 }).map((s) => `x-${s}`),
        async (value) => {
          const id = nid('p');
          const b = await run(
            doc([
              {
                type: 'paragraph',
                attrs: { id, align: value },
                content: [{ type: 'text', text: 'T' }],
              },
            ]),
          );
          const diags: Diagnostic[] = diagnosticsFor(b, 'enum_unknown', id);
          expect(diags.length).toBe(1);
          expect(blockLines(b, id).join('\n')).not.toContain(value);
        },
      ),
      { numRuns: 100 },
    );
  });
});
