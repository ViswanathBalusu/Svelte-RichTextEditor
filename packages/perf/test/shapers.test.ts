/**
 * Spike S5 in Node.js: the two WebAssembly shapers on the manifest's fonts. HarfRust and
 * harfbuzzjs must give the same glyphs, clusters and advances on the corpus lines, both must
 * apply the fonts' ligatures and kerning by default, and the feature switches must turn them off.
 * The browser side of the same comparison is e2e/s5.spec.ts.
 */
import { corpusStamp, loadDocument, type CorpusStamp } from '@docedit/corpus';
import { toFlow, type CdmEnvelopeLike } from '@docedit/layout';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fontManifest } from '../src/fonts.ts';
import { sampleLines, type SampleLine } from '../src/lines.ts';
import { coveredLines, differences, shapeLines } from '../src/s5.ts';
import { loadHarfbuzz } from '../src/shapers/harfbuzz.ts';
import { harfrustShaper, loadTextKernel } from '../src/shapers/harfrust.ts';
import { glyphKey, NO_KERN, NO_LIGA, type Shaper } from '../src/shapers/types.ts';

declare module 'vitest' {
  interface TaskMeta {
    corpus?: CorpusStamp;
  }
}

const pkg = resolve(import.meta.dirname, '..');
let hb: Shaper;
let hr: Shaper;
let lines: SampleLine[];

beforeAll(async () => {
  hb = (await loadHarfbuzz()).shaper;
  hr = harfrustShaper(
    (await loadTextKernel(new Uint8Array(readFileSync(join(pkg, 'wasm/bin/harfrust-shaper.wasm')))))
      .module,
  );
  for (const f of fontManifest.fonts) {
    const bytes = new Uint8Array(readFileSync(join(pkg, 'fonts', f.file)));
    hb.loadFont(f.file, bytes);
    hr.loadFont(f.file, bytes);
  }
  const doc = await loadDocument('pages-20');
  lines = coveredLines(
    hb,
    sampleLines(toFlow(doc.envelope as unknown as CdmEnvelopeLike), 'pages-20'),
  ).kept;
});

beforeEach(({ task }) => {
  task.meta.corpus = corpusStamp();
});

describe('WebAssembly shapers in Node.js', () => {
  it('HarfRust and harfbuzzjs agree glyph for glyph on the pages-20 lines', async () => {
    expect(lines.length).toBeGreaterThan(800);
    for (const l of lines)
      for (const s of l.segments)
        expect(glyphKey(hr.shape(s.face, s.text))).toBe(glyphKey(hb.shape(s.face, s.text)));
    const a = await shapeLines(hb, lines);
    const b = await shapeLines(hr, lines);
    expect(b.digest).toBe(a.digest);
    expect(differences(b.widths.default, a.widths.default).maxAbs).toBe(0);
  });

  it('applies ligatures and kerning by default, and turns them off on request', () => {
    const serif = 'files/NotoSerif-Regular.ttf';
    for (const shaper of [hb, hr]) {
      // "fi" is one glyph with ligatures, two without.
      expect(shaper.shape(serif, 'fi')).toHaveLength(1);
      expect(shaper.shape(serif, 'fi', NO_LIGA)).toHaveLength(2);
      // The kerning pair "AV" is narrower than its two glyphs set apart.
      const kerned = shaper.shape(serif, 'AV').reduce((s, g) => s + g.advance, 0);
      const plain = shaper.shape(serif, 'AV', NO_KERN).reduce((s, g) => s + g.advance, 0);
      expect(kerned).toBeLessThan(plain);
    }
  });

  it('measures CJK text with the CJK face and drops lines whose characters it lacks', () => {
    const cjk = lines.filter((l) => l.role === 'cjk');
    expect(cjk.length).toBeGreaterThan(0);
    for (const l of cjk)
      for (const s of l.segments)
        expect(hb.shape(s.face, s.text).every((g) => g.glyph !== 0)).toBe(true);
  });
});
