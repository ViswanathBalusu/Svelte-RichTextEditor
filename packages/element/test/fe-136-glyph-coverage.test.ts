/**
 * FE-136 criterion 4 in the element: the coverage of the fonts is read from the files of the
 * manifest with the converter's own reader of the `cmap` table, for the families the document names
 * and the default family. The font is KaTeX's Main face, a real TrueType file: it has `A` and `Γ`
 * and no `ω`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { covered } from '@docedit/engine/headless';
import { loadGlyphCoverage, usedFamilies } from '../src/font-coverage.ts';

const MAIN = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL('../node_modules/katex/dist/fonts/KaTeX_Main-Regular.ttf', import.meta.url),
    ),
  ),
);
const HASH = 'a'.repeat(64);

const face = (family: string, url: string) => ({
  family,
  licence: 'OFL-1.1',
  faces: [{ url, sha256: HASH, weight: 400, italic: false }],
});

const manifest = {
  defaultFamily: 'Plain Face',
  families: [
    face('Plain Face', 'https://fonts.test/plain.ttf'),
    face('Test Face', 'https://fonts.test/test.ttf'),
  ],
};
const port = { manifest: () => Promise.resolve(manifest) };

function reader(files: Record<string, Uint8Array | 'fail'>, asked: string[] = []) {
  return (url: string): Promise<Uint8Array> => {
    asked.push(url);
    const file = files[url];
    return file === undefined || file === 'fail'
      ? Promise.reject(new Error('no such file'))
      : Promise.resolve(file);
  };
}

const has = (ranges: ReturnType<Awaited<ReturnType<typeof loadGlyphCoverage>>>, char: string) =>
  ranges !== null && covered(ranges, char.codePointAt(0)!);

describe('the coverage of the fonts the document uses (FE-136 criterion 4)', () => {
  it('reads the named families and the default, and answers from the character maps', async () => {
    const asked: string[] = [];
    const coverage = await loadGlyphCoverage(
      port,
      ['Test Face'],
      reader({ 'https://fonts.test/plain.ttf': MAIN, 'https://fonts.test/test.ttf': MAIN }, asked),
    );
    expect(asked.sort()).toEqual(['https://fonts.test/plain.ttf', 'https://fonts.test/test.ttf']);
    for (const family of ['Test Face', null]) {
      expect(has(coverage(family), 'A')).toBe(true);
      expect(has(coverage(family), 'Γ')).toBe(true);
      expect(has(coverage(family), 'ω')).toBe(false);
    }
  });

  it('knows nothing of a family with no file, and of a file that cannot be read', async () => {
    const coverage = await loadGlyphCoverage(
      port,
      ['Test Face'],
      reader({ 'https://fonts.test/plain.ttf': MAIN, 'https://fonts.test/test.ttf': 'fail' }),
    );
    expect(coverage('Test Face')).toBeNull();
    expect(coverage(null)).not.toBeNull();
    // No manifest family, no substitute, but the default family is the fallback of the lookup.
    expect(coverage('Nobody')).not.toBeNull();
  });

  it('reads a family used later when it is first asked for, and answers from then on', async () => {
    const asked: string[] = [];
    const coverage = await loadGlyphCoverage(
      port,
      [],
      reader({ 'https://fonts.test/plain.ttf': MAIN, 'https://fonts.test/test.ttf': MAIN }, asked),
    );
    expect(asked).toEqual(['https://fonts.test/plain.ttf']);
    expect(coverage('Test Face')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(has(coverage('Test Face'), 'A')).toBe(true);
    expect(asked).toEqual(['https://fonts.test/plain.ttf', 'https://fonts.test/test.ttf']);
  });

  it('is unknown everywhere without a manifest family or default', async () => {
    const coverage = await loadGlyphCoverage(
      { manifest: () => Promise.resolve({ families: [] }) },
      ['X'],
      reader({}),
    );
    expect(coverage('X')).toBeNull();
    expect(coverage(null)).toBeNull();
  });
});

describe('the families a document names', () => {
  it('collects font marks and style definitions', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [{ type: 'style_def', attrs: { id: 'S', fontFamily: 'Style Face' } }],
        },
        {
          type: 'body',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'a',
                  marks: [{ type: 'fontFamily', attrs: { value: 'Mark Face' } }],
                },
                { type: 'text', text: 'b', marks: [{ type: 'bold' }] },
              ],
            },
          ],
        },
      ],
    };
    expect(usedFamilies(doc).sort()).toEqual(['Mark Face', 'Style Face']);
  });
});
