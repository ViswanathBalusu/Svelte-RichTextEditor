/**
 * EXP-033 criterion 6, the glyph case (Node.js only). A flattened form-field value whose glyph the
 * fonts lack is reported with the field's identifier. The converter's glyph check (EXP-026,
 * `fonts/check.ts`) receives the field id as the block id of the diagnostic. The severity follows
 * EXP-026: an error in a final export, a warning in a preview. The criterion says "a warning"; the
 * final-export error is EXP-026's rule (the accepted default; the criterion's wording says so in
 * the story). The width case is not measured by the converter: the class logs it and the worker
 * reports `field_too_wide` (`exp-033-field-width.compile.test.ts`).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FONTS, doc, nid, para, run, type J } from '../test/docs.ts';
import type { FontManifest } from '../src/index.ts';

type Range = readonly [number, number];

const LATIN: Range[] = [[0x20, 0x7e]];
const MATH: Range[] = [[0x2200, 0x22ff]];

/** The test manifest with Latin coverage on every text face, as in glyphs.missing.test.ts. */
function covered(): FontManifest {
  const withCoverage = <T extends object>(f: T, coverage: Range[]): T => ({
    ...f,
    coverage: coverage as never,
  });
  return {
    ...FONTS,
    families: FONTS.families.map((f) => ({
      ...f,
      regular: withCoverage(f.regular, LATIN),
      bold: withCoverage(f.bold, LATIN),
      italic: withCoverage(f.italic, LATIN),
      boldItalic: withCoverage(f.boldItalic, LATIN),
    })),
    math: withCoverage(FONTS.math, MATH),
  };
}

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/** A `form_field` text inline with a fixed id, so the diagnostic can be matched to it. */
function textField(id: string, value: string): J {
  return {
    type: 'form_field',
    attrs: { id, key: id, kind: 'text', label: `Label ${id}`, width: 2880, value },
  };
}

describe('EXP-033 criterion 6 (glyph case): a flattened value with a missing glyph names the field', () => {
  it('reports the missing glyph with the field identifier as the block, in a final export as an error', async () => {
    const fid = 'ff-glyph-0001';
    const b = await run(doc([para('Name: ', {}, [textField(fid, 'Ж')])]), { fonts: covered() });
    const missing = b.diagnostics.filter((d) => d.code === 'glyph_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.blockId).toBe(fid);
    expect(missing[0]!.severity).toBe('error');
    expect(missing[0]!.message).toContain(hex(0x416));
  });

  it('reports the same field in a preview as a warning, and still writes the bundle', async () => {
    const fid = 'ff-glyph-0002';
    const b = await run(doc([para('Name: ', {}, [textField(fid, 'Ж')])]), {
      fonts: covered(),
      profile: 'preview',
    });
    const missing = b.diagnostics.filter((d) => d.code === 'glyph_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.blockId).toBe(fid);
    expect(missing[0]!.severity).toBe('warning');
    expect(b.files['main.tex']).toBeTypeOf('string');
  });

  it('reports nothing for a field value that every face covers', async () => {
    const b = await run(doc([para('Name: ', {}, [textField(nid('ff'), 'Ada Lovelace, 1815')])]), {
      fonts: covered(),
    });
    expect(b.diagnostics.filter((d) => d.code === 'glyph_missing')).toEqual([]);
  });

  it('names the field identifier for any Cyrillic letter in its value (property)', async () => {
    const fonts = covered();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0x410, max: 0x44f }), async (cp) => {
        const fid = `ff-prop-${cp.toString(16)}`;
        const b = await run(
          doc([para('x ', {}, [textField(fid, `a${String.fromCodePoint(cp)}b`)])]),
          { fonts },
        );
        const missing = b.diagnostics.filter((d) => d.code === 'glyph_missing');
        expect(missing).toHaveLength(1);
        expect(missing[0]!.blockId).toBe(fid);
        expect(missing[0]!.message).toContain(hex(cp));
      }),
      { numRuns: 25 },
    );
  });
});
