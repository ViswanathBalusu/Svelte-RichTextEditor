/**
 * WASM-015: the kernel shapes Arabic and Tamil (an Indic script) as HarfBuzz does. Node.js only.
 * HarfBuzz's own WebAssembly build (harfbuzzjs 1.6.1) is the reference, as in WASM-006: the
 * kernel's advance of every UTF-16 code unit must equal the glyph advances of HarfBuzz, spread over
 * their clusters and rounded by the kernel's rule.
 *
 * The fonts are those of the harness's manifest (`fonts/manifest.json`): Amiri (Arabic) and Hind
 * Madurai (Tamil), both under the OFL, as the font policy requires (`licences/policy.json`). They
 * are given to the kernel by hash, the way the editor gives it the manifest's files. A Devanagari
 * face is not in the manifest (the one on the development machine, New Computer Modern, is under
 * the GUST Font Licence, which the policy does not allow for fonts), so Devanagari is checked
 * against the TeX Live copy by path and skipped where TeX Live is absent (`DOCEDIT_TEXLIVE`); it is
 * extra evidence and no criterion rests on it.
 *
 * The language of the run reaches both shapers. A font may have a language system of its own
 * (Amiri has one for Arabic, `ARA `, with a lookup that the default system lacks), so a comparison
 * has to give HarfBuzz the same language as the kernel; with `ar` on one side only the two differ
 * for 'ببب تتت ثثث' (the case that WASM-015 first reported as unexplained).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadNodeKernel, kernelIsBuilt } from '../../layout-kernel/node/index.ts';
import type { LayoutKernel } from '../../layout-kernel/src/index.ts';
import { fontManifest } from '../src/fonts.ts';
import { loadHarfbuzz, type LoadedHarfbuzz } from '../src/shapers/harfbuzz.ts';

const texlive = process.env['DOCEDIT_TEXLIVE'] ?? 'E:/texlive/2025';
const perf = resolve(import.meta.dirname, '..');

interface Source {
  readonly path: string;
  readonly language: string;
  readonly fromManifest: boolean;
}

const manifestFile = (alias: string): string => {
  const entry = fontManifest.fonts.find((f) => f.alias === alias);
  if (!entry) throw new Error(`the manifest has no ${alias}`);
  return resolve(perf, 'fonts', entry.file);
};

const FONTS: Record<'arabic' | 'tamil' | 'devanagari', Source> = {
  arabic: { path: manifestFile('Amiri'), language: 'ar', fromManifest: true },
  tamil: { path: manifestFile('Hind Madurai'), language: 'ta', fromManifest: true },
  devanagari: {
    path: `${texlive}/texmf-dist/fonts/opentype/public/newcomputermodern/NewCM08Devanagari-Regular.otf`,
    language: 'hi',
    fromManifest: false,
  },
};

const built = kernelIsBuilt();
const have = (key: keyof typeof FONTS): boolean => built && existsSync(FONTS[key].path);

let kernel: LayoutKernel;
let loaded: LoadedHarfbuzz;
const aliases: Record<string, string> = {};
const fonts = new Map<string, { font: unknown; upem: number }>();

beforeAll(async () => {
  if (!built) return;
  kernel = await loadNodeKernel();
  loaded = await loadHarfbuzz();
  const { hb } = loaded;
  for (const [key, source] of Object.entries(FONTS)) {
    if (!existsSync(source.path)) continue;
    const bytes = new Uint8Array(readFileSync(source.path));
    const sha = createHash('sha256').update(bytes).digest('hex');
    aliases[key] = `de-font-${sha}`;
    kernel.faces.load('', aliases[key], sha, bytes);
    const face = new hb.Face(new hb.Blob(bytes), 0);
    fonts.set(key, { font: new hb.Font(face), upem: face.upem });
  }
});

/** round half up of value * size * 64 / upem, in integers (the kernel's rule). */
function scaled(value: number, sizeTwips: number, upem: number): number {
  return Math.floor((2 * value * sizeTwips * 64 + upem) / (2 * upem));
}

/** What HarfBuzz gives for a language, put on code units the way the kernel puts them. */
function reference(key: string, text: string, sizeTwips: number, language: string): number[] {
  const { hb } = loaded;
  const entry = fonts.get(key)!;
  // One buffer, reset before each use: harfbuzzjs frees buffers only when it is collected.
  sharedBuffer ??= new hb.Buffer();
  const buffer = sharedBuffer;
  buffer.reset();
  buffer.addText(text);
  buffer.guessSegmentProperties();
  if (language) buffer.setLanguage(language);
  hb.shape(entry.font as InstanceType<typeof hb.Font>, buffer, []);
  const infos = buffer.getGlyphInfos();
  const positions = buffer.getGlyphPositions();
  const units = new Array<number>(text.length).fill(0);
  for (let i = 0; i < infos.length; i++)
    units[Math.min(infos[i]!.cluster, text.length - 1)]! += positions[i]!.xAdvance;
  return units.map((v) => scaled(v, sizeTwips, entry.upem));
}
let sharedBuffer: InstanceType<LoadedHarfbuzz['hb']['Buffer']> | undefined;

const styleOf = (key: keyof typeof FONTS, size: number, language: string) => ({
  alias: aliases[key]!,
  sizeTwips: size,
  language,
  features: '',
});

const ARABIC = [
  'السلام عليكم ورحمة الله وبركاته',
  'لا إله إلا الله — ﷲ',
  'محمد رسول الله، والذين معه',
  'العدد ١٢٣ والتاريخ ٢٠٢٦/١١/١٨',
  'كَتَبَ الْوَلَدُ الدَّرْسَ', // with vowel marks
  'ببب ثثث', // joining forms
  'ببب تتت ثثث', // the Arabic language system of Amiri changes the second word
  'بيت بنت تين نيت يبتني', // teeth in a row, with contextual alternates
];
const TAMIL = [
  'தமிழ்', // a pulli (virama) at the end
  'வணக்கம் உலகம்',
  'கொடு கோடு கௌரவம்', // split vowel signs, which are written around the consonant
  'கெடு கேடு கைவிடு', // prefix vowel signs, which move before the consonant
  'ஸ்ரீ க்ஷ ஜ்ஞ', // conjunct letters
  'பெண்கள் கல்வி தமிழ்நாடு',
  'ஒரு ஆசிரியர் மாணவர்களுக்குக் கற்பிக்கிறார்',
];
const DEVANAGARI = [
  'नमस्ते दुनिया',
  'हिन्दी भाषा का परिचय',
  'क्षत्रिय ज्ञान श्री द्वारा',
  'संस्कृत शास्त्र धर्म',
  'विद्यार्थियों की पुस्तकें',
  'कि की कु कू के कै को कौ',
];

describe.skipIf(!built)('complex scripts against HarfBuzz (WASM-015)', () => {
  it('has the Arabic and the Tamil face in the manifest, under the OFL', () => {
    for (const alias of ['Amiri', 'Hind Madurai']) {
      const entry = fontManifest.fonts.find((f) => f.alias === alias);
      expect(entry?.licence, alias).toBe('OFL-1.1');
    }
  });

  it.skipIf(!have('arabic'))('shapes Arabic as HarfBuzz does, with the language of the run', () => {
    for (const size of [200, 240, 330])
      for (const text of ARABIC) {
        const style = styleOf('arabic', size, 'ar');
        expect(Array.from(kernel.shaper.advances(style, text)), `${size}: ${text}`).toEqual(
          reference('arabic', text, size, 'ar'),
        );
      }
  });

  it.skipIf(!have('arabic'))('shapes Arabic as HarfBuzz does when the run has no language', () => {
    for (const size of [200, 330])
      for (const text of ARABIC) {
        const style = styleOf('arabic', size, '');
        expect(Array.from(kernel.shaper.advances(style, text)), `${size}: ${text}`).toEqual(
          reference('arabic', text, size, ''),
        );
      }
  });

  it.skipIf(!have('arabic'))(
    'explains the first difference: the language selects another language system of the font',
    () => {
      const text = 'ببب تتت ثثث';
      const withLanguage = Array.from(kernel.shaper.advances(styleOf('arabic', 200, 'ar'), text));
      const without = Array.from(kernel.shaper.advances(styleOf('arabic', 200, ''), text));
      // Only the first letter of the second word differs, in both engines alike.
      const differing = withLanguage.flatMap((v, i) => (v === without[i] ? [] : [i]));
      expect(differing).toEqual([4]);
      expect(withLanguage[4]).toBe(reference('arabic', text, 200, 'ar')[4]);
      expect(without[4]).toBe(reference('arabic', text, 200, '')[4]);
      expect(withLanguage[4]).not.toBe(without[4]);
    },
  );

  it.skipIf(!have('arabic'))(
    'gives joined Arabic letters different advances from the same letters apart',
    () => {
      const style = styleOf('arabic', 240, 'ar');
      const joined = kernel.shaper.width(style, 'ببب');
      const apart = kernel.shaper.width(style, 'ب') * 3;
      expect(joined).not.toBe(apart);
    },
  );

  it.skipIf(!have('tamil'))('shapes Tamil as HarfBuzz does, with the language of the run', () => {
    for (const size of [200, 240, 330])
      for (const text of TAMIL) {
        const style = styleOf('tamil', size, 'ta');
        expect(Array.from(kernel.shaper.advances(style, text)), `${size}: ${text}`).toEqual(
          reference('tamil', text, size, 'ta'),
        );
      }
  });

  it.skipIf(!have('tamil'))('shapes Tamil as HarfBuzz does when the run has no language', () => {
    for (const text of TAMIL) {
      const style = styleOf('tamil', 240, '');
      expect(Array.from(kernel.shaper.advances(style, text)), text).toEqual(
        reference('tamil', text, 240, ''),
      );
    }
  });

  it.skipIf(!have('tamil'))('puts the advance of a Tamil cluster on its first code unit', () => {
    // கொ is ka and the split vowel sign o (two code units); the cluster is one glyph or two,
    // and the advance of the cluster is on the first unit, as the layout engine reads it.
    const advances = Array.from(kernel.shaper.advances(styleOf('tamil', 240, 'ta'), 'கொ'));
    expect(advances.length).toBe(2);
    expect(advances[0]).toBeGreaterThan(0);
  });

  it.skipIf(!have('devanagari'))(
    'shapes Devanagari as HarfBuzz does, with conjuncts, matras and reordering',
    () => {
      for (const size of [200, 240, 330])
        for (const text of DEVANAGARI) {
          const style = styleOf('devanagari', size, 'hi');
          expect(Array.from(kernel.shaper.advances(style, text)), `${size}: ${text}`).toEqual(
            reference('devanagari', text, size, 'hi'),
          );
        }
    },
  );

  it.skipIf(!have('devanagari'))('shapes a conjunct into fewer glyph advances than letters', () => {
    const style = styleOf('devanagari', 240, 'hi');
    // क्ष is three code units (ka, virama, ssa); the advance of a cluster is on its first unit.
    const advances = Array.from(kernel.shaper.advances(style, 'क्ष'));
    expect(advances.length).toBe(3);
    expect(advances[0]).toBeGreaterThan(0);
    expect(advances[1]).toBe(0);
    expect(advances[2]).toBe(0);
  });
});
