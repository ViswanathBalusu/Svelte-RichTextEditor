/**
 * EXP-048 criterion 3 (Node.js only; owner decision 62): a font whose administrator did not mark it
 * for server-side use is used on screen only. A job does not load it: the family is not in the
 * bundle's font list, the paragraph takes the default family and the fallback chain, and one
 * warning names the family. A family marked for server use, or a default-set family with no mark,
 * is loaded as before. The manifest's `serverUse` is set by the service (BE-048, not built).
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, FONTS, para, run, CLASS_FILES, type J } from '../test/docs.ts';
import type { FallbackFace, FontManifest } from './bundle.ts';
import { preflight } from './preflight.ts';
import { serverFonts } from './server-fonts.ts';

const TENANT = 'Acme Brand Serif';
const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;
const textRun = (text: string, marks: J[] = []): J => ({ type: 'text', text, marks });
const familyMark = (value: string): J => ({ type: 'fontFamily', attrs: { value } });
const hash = (c: string): string => c.repeat(64);

const SYMBOLS: FallbackFace = {
  name: 'Noto Sans Symbols',
  file: `${hash('8')}.ttf`,
  sha256: hash('8'),
  licence: 'OFL-1.1',
};

const manifest = (serverUse: boolean | undefined): FontManifest => ({
  ...FONTS,
  fallback: [SYMBOLS, FONTS.math],
  families: [
    ...FONTS.families,
    {
      name: TENANT,
      lineHeight: 1200,
      regular: { file: `${hash('5')}.ttf`, sha256: hash('5') },
      bold: { file: `${hash('6')}.ttf`, sha256: hash('6') },
      italic: { file: `${hash('7')}.ttf`, sha256: hash('7') },
      boldItalic: { file: `${hash('4')}.ttf`, sha256: hash('4') },
      licence: 'Proprietary-tenant-licence',
      ...(serverUse === undefined ? {} : { serverUse }),
    },
  ],
});

const body = (): J => ({
  ...para('', {}),
  content: [textRun('Brand text.', [familyMark(TENANT)])],
});

describe('EXP-048 criterion 3: a font not permitted for server-side use is not loaded', () => {
  it('does not list the family or its files in the bundle, and uses the default family', async () => {
    const p = body();
    const b = await run(doc([p]), { fonts: manifest(false), classFiles: CLASS_FILES });
    const all = Object.values(b.files).join('\n');
    for (const c of ['5', '6', '7', '4']) expect(all).not.toContain(hash(c));
    expect(all).not.toContain(TENANT);
    expect(b.manifest.fonts.map((f) => f.name)).not.toContain(TENANT);
    expect(blockLines(b, idOf(p)).join('\n')).toMatch(/\\DEfont\{1\}/);
    expect(b.ok).toBe(true);
  });

  it('writes the fallback chain of the manifest, in order', async () => {
    const b = await run(doc([body()]), { fonts: manifest(false), classFiles: CLASS_FILES });
    const chain = [
      ...b.files['styles.tex']!.matchAll(/\\DEfallback\{([0-9a-f]{64}\.(?:ttf|otf|ttc|otc))\}/g),
    ].map((m) => m[1]);
    expect(chain).toEqual([SYMBOLS.file, FONTS.math.file]);
  });

  it('names the family in one warning, however many paragraphs use it', async () => {
    const b = await run(doc([body(), body(), body()]), {
      fonts: manifest(false),
      classFiles: CLASS_FILES,
    });
    const d = b.diagnostics.filter((x) => x.code === 'font_server_use_not_permitted');
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe('warning');
    expect(d[0]!.message).toContain(TENANT);
    expect(b.diagnostics.some((x) => x.code === 'font_family_missing')).toBe(false);
  });

  it('says nothing when the document does not use the family', async () => {
    const b = await run(doc([para('Plain.')]), { fonts: manifest(false), classFiles: CLASS_FILES });
    expect(b.diagnostics.some((x) => x.code === 'font_server_use_not_permitted')).toBe(false);
  });

  it.each([true, undefined])('loads the family when serverUse is %s', async (flag) => {
    const p = body();
    const b = await run(doc([p]), { fonts: manifest(flag), classFiles: CLASS_FILES });
    expect(b.diagnostics.some((x) => x.code === 'font_server_use_not_permitted')).toBe(false);
    expect(b.diagnostics.some((x) => x.code === 'font_family_missing')).toBe(false);
    expect(blockLines(b, idOf(p)).join('\n')).toMatch(/\\DEfont\{3\}/);
    expect(Object.values(b.files).join('\n')).toContain(hash('5'));
  });

  it('leaves the manifest as it was when every family is permitted', () => {
    const m = manifest(true);
    expect(serverFonts(m).fonts).toBe(m);
    expect(serverFonts(manifest(false)).excluded.map((f) => f.name)).toEqual([TENANT]);
  });

  it('checks no character against a family the job may not load', () => {
    const covered = { ...manifest(false) };
    covered.families = covered.families.map((f) =>
      f.name === TENANT
        ? {
            ...f,
            regular: { ...f.regular, coverage: [[0x20, 0x7e]] },
            bold: { ...f.bold, coverage: [[0x20, 0x7e]] },
            italic: { ...f.italic, coverage: [[0x20, 0x7e]] },
            boldItalic: { ...f.boldItalic, coverage: [[0x20, 0x7e]] },
          }
        : f,
    );
    // The family covers only Basic Latin; no other family has coverage, so no character is checked.
    const p = { ...para('', {}), content: [textRun('Brand 中.', [familyMark(TENANT)])] };
    expect(preflight(doc([p]), covered)).toEqual([]);
  });
});
