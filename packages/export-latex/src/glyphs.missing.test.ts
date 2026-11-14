/**
 * Missing glyphs (Node.js only): the converter's glyph check (`fonts/check.ts`, EXP-026). The tests
 * give the manifest coverage for every face and for the math face, then check the diagnostics. A
 * character no face covers is an error in a final export and a warning in a preview, and it names
 * the block and the code point. The tests do not compile a PDF, so the job that must fail and
 * release no PDF (criterion 3), the class's `\tracinglostchars` (criterion 2) and the ligature
 * setting of fallback faces (criterion 5) are not checked here and no criterion for them is ticked.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FONTS, doc, para, run } from '../test/docs.ts';
import type { FontManifest } from '../src/index.ts';

type Range = readonly [number, number];

const LATIN: Range[] = [[0x20, 0x7e]];
const MATH: Range[] = [[0x2200, 0x22ff]];

/** The test manifest with Latin coverage on every text face and a math face with its own range. */
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

/** A paragraph whose text is `Ж` (U+0416), which no face of the test manifest covers. */
const MISSING = 'Ж';

describe('EXP-026 a character no font covers is reported with its block and code point (criterion 1)', () => {
  it('reports an error diagnostic that names the paragraph and the code point', async () => {
    const pid = 'p-missing-0001';
    const b = await run(doc([para(`Plain ${MISSING} text.`, { id: pid })]), { fonts: covered() });
    const missing = b.diagnostics.filter((d) => d.code === 'glyph_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.severity).toBe('error');
    expect(missing[0]!.blockId).toBe(pid);
    expect(missing[0]!.message).toContain(hex(0x416));
  });

  it('reports nothing for text every face covers', async () => {
    const b = await run(doc([para('Plain ASCII text, with punctuation: "quotes"; ok!?')]), {
      fonts: covered(),
    });
    expect(b.diagnostics.filter((d) => d.code === 'glyph_missing')).toEqual([]);
  });

  it('reports each missing code point once per block, however often it occurs', async () => {
    const pid = 'p-missing-0002';
    const b = await run(doc([para(`${MISSING}${MISSING} and ${MISSING}`, { id: pid })]), {
      fonts: covered(),
    });
    const missing = b.diagnostics.filter((d) => d.code === 'glyph_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.blockId).toBe(pid);
  });

  it('names the block and the code point for any character outside the Latin coverage (property)', async () => {
    const fonts = covered();
    // Cyrillic letters U+0410 to U+044F: none is in the test coverage, so each one is a miss.
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0x410, max: 0x44f }), async (cp) => {
        const ch = String.fromCodePoint(cp);
        const pid = `p-prop-${cp.toString(16)}`;
        const b = await run(doc([para(`a${ch}b`, { id: pid })]), { fonts });
        const missing = b.diagnostics.filter((d) => d.code === 'glyph_missing');
        expect(missing).toHaveLength(1);
        expect(missing[0]!.blockId).toBe(pid);
        expect(missing[0]!.severity).toBe('error');
        expect(missing[0]!.message).toContain(hex(cp));
      }),
      { numRuns: 25 },
    );
  });
});

describe('EXP-026 a final export reports a miss as an error, a preview as a warning (criteria 3 and 4, converter side)', () => {
  it('makes a missing glyph an error in the default (final) profile', async () => {
    const b = await run(doc([para(MISSING)]), { fonts: covered() });
    const missing = b.diagnostics.filter((d) => d.code === 'glyph_missing');
    expect(missing.map((d) => d.severity)).toEqual(['error']);
  });

  it('reports a missing glyph in a preview as a warning diagnostic, and still writes the bundle', async () => {
    const pid = 'p-preview-0001';
    const b = await run(doc([para(`Preview ${MISSING}`, { id: pid })]), {
      fonts: covered(),
      profile: 'preview',
    });
    const missing = b.diagnostics.filter((d) => d.code === 'glyph_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.severity).toBe('warning');
    expect(missing[0]!.blockId).toBe(pid);
    expect(b.files['main.tex']).toBeTypeOf('string');
  });

  it('writes the class option glyphs=strict for a final export and glyphs=report for a preview', async () => {
    const final = await run(doc([para('Text.')]), { fonts: covered() });
    const preview = await run(doc([para('Text.')]), { fonts: covered(), profile: 'preview' });
    expect(final.files['main.tex']).toContain('glyphs=strict');
    expect(preview.files['main.tex']).toContain('glyphs=report');
  });
});
