/**
 * EXP-048 criterion 4 (Node.js only): a tenant font that is no longer in the job's font manifest.
 * The converter sees only the manifest the job gives it, so a removed font is a family the
 * manifest lacks. The paragraph then takes the default family, the glyph fallback chain of the
 * manifest is written to `styles.tex`, and a warning names the family. Criteria 1 to 3 need the
 * worker's font mount, the job's tenant check and the licence rule, which are not in this package.
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, FONTS, para, run, CLASS_FILES, type J } from '../test/docs.ts';
import type { FallbackFace, FontManifest } from './bundle.ts';

const TENANT = 'Acme Brand Serif';
const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;
const textRun = (text: string, marks: J[] = []): J => ({ type: 'text', text, marks });
const familyMark = (value: string): J => ({ type: 'fontFamily', attrs: { value } });
const hash = (c: string): string => c.repeat(64);

/** A fallback face of the chain, as the job names it (EXP-047 criterion 4). */
const SYMBOLS: FallbackFace = {
  name: 'Noto Sans Symbols',
  file: `${hash('8')}.ttf`,
  sha256: hash('8'),
  licence: 'OFL-1.1',
};

/** The default manifest with the fallback chain given, and the tenant family absent. */
const WITHOUT_TENANT: FontManifest = { ...FONTS, fallback: [SYMBOLS, FONTS.math] };

/** The same manifest, with the tenant family present, as in that tenant's job. */
const WITH_TENANT: FontManifest = {
  ...WITHOUT_TENANT,
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
    },
  ],
};

describe('EXP-048 criterion 4: a removed tenant font falls back and a warning names the family', () => {
  it('reports a warning that names the family on the paragraph that uses it', async () => {
    const body = { ...para('', {}), content: [textRun('Brand text.', [familyMark(TENANT)])] };
    const bundle = await run(doc([body]), { fonts: WITHOUT_TENANT, classFiles: CLASS_FILES });
    const d = bundle.diagnostics.find(
      (x) => x.code === 'font_family_missing' && x.blockId === idOf(body),
    );
    expect(d).toBeDefined();
    expect(d?.severity).toBe('warning');
    expect(d?.message).toContain(TENANT);
    // A warning does not stop the export.
    expect(bundle.ok).toBe(true);
  });

  it('prints the paragraph in the default family, which is the first family of the manifest', async () => {
    const body = { ...para('', {}), content: [textRun('Brand text.', [familyMark(TENANT)])] };
    const bundle = await run(doc([body]), { fonts: WITHOUT_TENANT, classFiles: CLASS_FILES });
    expect(blockLines(bundle, idOf(body)).join('\n')).toMatch(/\\DEfont\{1\}/);
  });

  it('writes the fallback chain of the manifest to styles.tex, in order', async () => {
    const body = { ...para('', {}), content: [textRun('Brand text.', [familyMark(TENANT)])] };
    const bundle = await run(doc([body]), { fonts: WITHOUT_TENANT, classFiles: CLASS_FILES });
    const styles = bundle.files['styles.tex']!;
    const chain = [...styles.matchAll(/\\DEfallback\{([0-9a-f]{64}\.(?:ttf|otf|ttc|otc))\}/g)].map(
      (m) => m[1],
    );
    expect(chain).toEqual([SYMBOLS.file, FONTS.math.file]);
  });

  it('gives one warning for each paragraph that uses the removed family', async () => {
    const a = { ...para('', {}), content: [textRun('One.', [familyMark(TENANT)])] };
    const b = { ...para('', {}), content: [textRun('Two.', [familyMark(TENANT)])] };
    const bundle = await run(doc([a, b]), { fonts: WITHOUT_TENANT, classFiles: CLASS_FILES });
    const ids = bundle.diagnostics
      .filter((x) => x.code === 'font_family_missing')
      .map((x) => x.blockId);
    expect(ids).toEqual([idOf(a), idOf(b)]);
  });

  it('gives no such warning when the tenant family is in the job manifest', async () => {
    const body = { ...para('', {}), content: [textRun('Brand text.', [familyMark(TENANT)])] };
    const bundle = await run(doc([body]), { fonts: WITH_TENANT, classFiles: CLASS_FILES });
    expect(bundle.diagnostics.some((x) => x.code === 'font_family_missing')).toBe(false);
    expect(blockLines(bundle, idOf(body)).join('\n')).toMatch(/\\DEfont\{3\}/);
  });
});
