/**
 * EXP-047 criterion 4 (Node.js only): the bundle's manifest records each font's licence and the
 * fallback chain that the glyph check (`fonts/check.ts`, EXP-026) uses. The chain is the manifest's
 * `fallback` list in order, or the math face when the list is absent. The tests show that the
 * manifest lists the chain in the order the check reads it, and that a character covered only by a
 * later face of the chain is not reported. The other criteria (the worker's read-only font path,
 * the hash check on the worker, the image's name cache) are not built here.
 */
import { describe, expect, it } from 'vitest';
import { FONTS, doc, para, run } from '../../test/docs.ts';
import type { FallbackFace, FontFace, FontManifest } from '../bundle.ts';

type Range = readonly [number, number];

const LATIN: Range[] = [[0x20, 0x7e]];
const GREEK: Range[] = [[0x391, 0x3c9]];
const CJK: Range[] = [[0x4e00, 0x4eff]];

const withCoverage = <T extends FontFace>(f: T, coverage: Range[]): T => ({
  ...f,
  coverage: coverage as FontFace['coverage'],
});

/** The test manifest with coverage on every face, and a fallback chain of two faces. */
function manifest(fallback: FallbackFace[] | undefined): FontManifest {
  return {
    ...FONTS,
    families: FONTS.families.map((f) => ({
      ...f,
      regular: withCoverage(f.regular, LATIN),
      bold: withCoverage(f.bold, LATIN),
      italic: withCoverage(f.italic, LATIN),
      boldItalic: withCoverage(f.boldItalic, LATIN),
    })),
    math: withCoverage(FONTS.math, [[0x2200, 0x22ff]]),
    ...(fallback ? { fallback } : {}),
  };
}

const GREEK_FACE: FallbackFace = {
  name: 'Noto Sans Greek',
  file: `${'7'.repeat(64)}.ttf`,
  sha256: '7'.repeat(64),
  licence: 'OFL-1.1',
  coverage: GREEK as FontFace['coverage'],
} as FallbackFace;

const CJK_FACE: FallbackFace = {
  name: 'Noto Sans CJK',
  file: `${'8'.repeat(64)}.otf`,
  sha256: '8'.repeat(64),
  licence: 'OFL-1.1',
  coverage: CJK as FontFace['coverage'],
} as FallbackFace;

const text = (s: string) => doc([para(s)]);

describe("EXP-047 the manifest records each font's licence and the fallback chain (criterion 4)", () => {
  it('records a licence for every entry, and each family, the math face and each fallback face', async () => {
    const b = await run(text('Plain text.'), { fonts: manifest([GREEK_FACE, CJK_FACE]) });
    expect(b.manifest.fonts.length).toBeGreaterThan(0);
    for (const f of b.manifest.fonts) {
      expect(f.licence).toMatch(/\S/);
      expect(f.files.length).toBeGreaterThan(0);
    }
    expect(b.manifest.fonts.filter((f) => f.role === 'text').map((f) => f.licence)).toEqual([
      'OFL-1.1',
      'OFL-1.1',
    ]);
    expect(b.manifest.fonts.find((f) => f.role === 'math')?.licence).toBe(FONTS.math.licence);
  });

  it('lists the fallback chain in the order the glyph check reads it, with the same file and hash', async () => {
    const b = await run(text('Plain text.'), { fonts: manifest([GREEK_FACE, CJK_FACE]) });
    const chain = b.manifest.fonts.filter((f) => f.role === 'fallback');
    expect(chain.map((f) => f.family)).toEqual(['Noto Sans Greek', 'Noto Sans CJK']);
    expect(chain.map((f) => f.licence)).toEqual(['OFL-1.1', 'OFL-1.1']);
    expect(chain[0]!.files).toEqual([{ file: GREEK_FACE.file, sha256: GREEK_FACE.sha256 }]);
    expect(chain[1]!.files).toEqual([{ file: CJK_FACE.file, sha256: CJK_FACE.sha256 }]);
  });

  it('records the math face as the chain when the manifest has no fallback list', async () => {
    const b = await run(text('Plain text.'), { fonts: manifest(undefined) });
    expect(b.manifest.fonts.filter((f) => f.role === 'fallback')).toEqual([]);
    const math = b.manifest.fonts.filter((f) => f.role === 'math');
    expect(math).toHaveLength(1);
    expect(math[0]!.files[0]!.sha256).toBe(FONTS.math.sha256);
  });

  it('uses the chain the manifest records: a character only a later fallback face covers is not reported', async () => {
    const fonts = manifest([GREEK_FACE, CJK_FACE]);
    const ok = await run(text('中'), { fonts });
    expect(ok.diagnostics.filter((d) => d.code === 'glyph_missing')).toEqual([]);
    const greek = await run(text('α'), { fonts });
    expect(greek.diagnostics.filter((d) => d.code === 'glyph_missing')).toEqual([]);
    const none = await run(text('Ж'), { fonts });
    expect(none.diagnostics.filter((d) => d.code === 'glyph_missing')).toHaveLength(1);
  });
});
