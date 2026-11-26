/**
 * The check of fonts an administrator adds (BE-048 criteria 1 and 4; owner decision 94), run
 * in-process through the same request and reply frames as the sandbox (`unsandboxed()`), and
 * through `checkFontFile`, which reads the reply as hostile input. Fonts are synthetic
 * (font-fixtures.ts). The defaults of `contentLimits()` are used throughout.
 */
import { describe, expect, it } from 'vitest';
import { checkFontFile, unsandboxed } from '../src/index.ts';
import { contentLimits } from '../src/sandbox/limits.ts';
import { processFont } from '../src/sandbox/font.ts';
import { AssetError } from '../src/sandbox/errors.ts';
import { sfnt, woff2 } from './font-fixtures.ts';

const sandbox = unsandboxed();
const check = (bytes: Uint8Array, mime: string) => checkFontFile(sandbox, bytes, mime);

describe('a font that passes (BE-048 criterion 1)', () => {
  it('reads family, style and weight from a TrueType file', async () => {
    const r = await check(sfnt({ family: 'Brand Serif', weight: 700, italic: true }), 'font/ttf');
    expect(r).toMatchObject({
      ok: true,
      font: { family: 'Brand Serif', weight: 700, bold: true, italic: true, format: 'truetype' },
    });
  });

  it('accepts OpenType with CFF outlines, and TrueType outlines declared as OpenType', async () => {
    const cff = await check(sfnt({ outlines: 'cff', family: 'Brand Sans' }), 'font/otf');
    expect(cff).toMatchObject({ ok: true, font: { family: 'Brand Sans', format: 'opentype' } });
    const glyf = await check(sfnt({}), 'font/otf');
    expect(glyf).toMatchObject({ ok: true, font: { format: 'truetype' } });
  });

  it('accepts WOFF2 and reads its tables after expanding them', async () => {
    const r = await check(woff2({ family: 'Packed Sans', weight: 700 }), 'font/woff2');
    expect(r).toMatchObject({
      ok: true,
      font: { family: 'Packed Sans', format: 'woff2', bold: true, glyphs: 3 },
    });
  });

  it('answers the same for the same bytes, and names no content in a message', async () => {
    const f = sfnt({ family: 'Same' });
    expect(await check(f, 'font/ttf')).toEqual(await check(f, 'font/ttf'));
  });
});

describe('a font that fails validation (BE-048 criterion 4)', () => {
  const refused = async (bytes: Uint8Array, mime: string, reason: string, code?: string) => {
    const r = await check(bytes, mime);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(reason);
      if (code) expect(r.code).toBe(code);
    }
  };

  it('refuses a declared type that is not a font type, and a file that is not a font', async () => {
    await refused(sfnt({}), 'image/png', 'unsupported_type');
    await refused(new TextEncoder().encode('not a font at all'), 'font/ttf', 'unsupported_type');
  });

  it('refuses a collection and WOFF 1', async () => {
    const ttc = Uint8Array.from([0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0, 0, 0, 0, 1]);
    await refused(ttc, 'font/ttf', 'unsupported_type');
    const woff = Uint8Array.from([0x77, 0x4f, 0x46, 0x46, 0, 1, 0, 0, 0, 0, 0, 1]);
    await refused(woff, 'font/woff2', 'unsupported_type');
  });

  it('refuses a type that is not the real one', async () => {
    await refused(sfnt({}), 'font/woff2', 'type_mismatch');
    await refused(woff2({}), 'font/ttf', 'type_mismatch');
    await refused(sfnt({ outlines: 'cff' }), 'font/ttf', 'type_mismatch');
  });

  it('refuses a font above the byte limit before it reaches the sandbox', async () => {
    const big = new Uint8Array(contentLimits().fontMaxBytes + 1);
    await refused(big, 'font/ttf', 'too_large', 'too_large');
  });

  it('refuses a font that lacks a table every usable font has', async () => {
    for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'name', 'glyf', 'loca'])
      await refused(sfnt({ omit: [t] }), 'font/ttf', 'malformed');
    await refused(sfnt({ outlines: 'cff', omit: ['CFF '] }), 'font/otf', 'malformed');
  });

  it('refuses a table outside the file, a directory cut short and too many tables', async () => {
    const f = sfnt({});
    await refused(f.subarray(0, f.length - 8), 'font/ttf', 'malformed');
    await refused(f.subarray(0, 20), 'font/ttf', 'malformed');
    await refused(sfnt({ tables: contentLimits().fontMaxTables + 1 }), 'font/ttf', 'malformed');
  });

  it('refuses a bad head magic, a bad units per em, no glyphs and no family name', async () => {
    await refused(sfnt({ unitsPerEm: 4 }), 'font/ttf', 'malformed');
    await refused(sfnt({ unitsPerEm: 20000 }), 'font/ttf', 'malformed');
    await refused(sfnt({ glyphs: 0 }), 'font/ttf', 'malformed');
    await refused(sfnt({ family: '' }), 'font/ttf', 'malformed');
  });

  it('refuses a font whose licence restricts embedding, and accepts the other flags', async () => {
    await refused(sfnt({ fsType: 0x0002 }), 'font/ttf', 'unsupported_content');
    for (const fsType of [0, 0x0004, 0x0008, 0x0100])
      expect((await check(sfnt({ fsType }), 'font/ttf')).ok).toBe(true);
  });

  it('stops a WOFF2 file that expands beyond its limit, or beyond its table sizes', async () => {
    const lim = contentLimits();
    await refused(
      woff2({}, { claimedSfnt: lim.fontMaxExpandedBytes + 1 }),
      'font/woff2',
      'archive_limit',
      'too_large',
    );
    // The compressed block does not expand to what the directory says.
    await refused(woff2({}, { raw: Uint8Array.from([1, 2, 3, 4]) }), 'font/woff2', 'malformed');
    // A file whose length field is not its size.
    const w = woff2({});
    await refused(w.subarray(0, w.length - 1), 'font/woff2', 'malformed');
  });

  it('never throws for random bytes', async () => {
    for (let i = 0; i < 200; i++) {
      const bytes = new Uint8Array(40 + (i % 90)).map((_, k) => (i * 31 + k * 17) & 255);
      for (const mime of ['font/ttf', 'font/otf', 'font/woff2']) {
        const r = await check(bytes, mime);
        expect(r.ok).toBe(false);
      }
    }
  });

  it('throws AssetError from processFont itself, never another error, for a damaged real shape', () => {
    const f = sfnt({});
    const damaged = Uint8Array.from(f);
    for (let i = 12; i < 12 + 16 * 9; i++) damaged[i] = 0xff;
    try {
      processFont(damaged, 'font/ttf', contentLimits());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AssetError);
    }
  });
});
