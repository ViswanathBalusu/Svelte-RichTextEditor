// FE-069 criterion 3, Node.js half of `katex-fonts.ts`: each KaTeX family's alias is the SHA-256 of
// its files' hashes; the sheet for the shadow root keeps no `@font-face` rule and names no `KaTeX_*`
// family; the faces go on the font set under the aliases, once, and a host face is left alone.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PageFonts } from './font-loader.ts';
import { FONT_ALIAS_PREFIX, type FontFaceLike } from './font-registration.ts';
import { KATEX_FONT_ROWS, katexFontFiles } from './katex-font-manifest.ts';
import {
  KATEX_FAMILIES,
  katexFamilyAliases,
  katexSheetText,
  registerKatexFaces,
} from './katex-fonts.ts';

const here = dirname(fileURLToPath(import.meta.url));
const katexCss = readFileSync(
  join(here, '..', 'node_modules', 'katex', 'dist', 'katex.min.css'),
  'utf8',
);

interface Face extends FontFaceLike {
  readonly style: string;
  readonly weight: string;
  readonly url: string;
}

function fakePage(initial: Face[] = []): PageFonts & { faces: Face[] } {
  const faces = [...initial];
  return {
    faces,
    set: { add: (f) => faces.push(f as Face), [Symbol.iterator]: () => faces[Symbol.iterator]() },
    make: (alias, url, style, weight) => ({ family: alias, url, style, weight }),
  };
}

describe('KaTeX fonts under family aliases (FE-069 criterion 3)', () => {
  it('derives each family alias from the SHA-256 of its sorted file hashes', async () => {
    const aliases = await katexFamilyAliases();
    expect([...aliases.keys()]).toEqual(KATEX_FAMILIES);
    expect(KATEX_FAMILIES).toHaveLength(12);
    for (const family of KATEX_FAMILIES) {
      const hashes = KATEX_FONT_ROWS.filter((r) => r.family === family)
        .map((r) => r.hash)
        .sort();
      const expected = createHash('sha256').update(hashes.join('\n'), 'utf8').digest('hex');
      expect(aliases.get(family), family).toBe(FONT_ALIAS_PREFIX + expected);
    }
    expect(new Set(aliases.values()).size).toBe(12);
  });

  it('rewrites the KaTeX sheet: no @font-face, no KaTeX_ name, every family on its alias', async () => {
    const aliases = await katexFamilyAliases();
    expect(katexCss).toContain('@font-face');
    const sheet = katexSheetText(katexCss, aliases);
    expect(sheet).not.toContain('@font-face');
    expect(sheet).not.toContain('KaTeX_');
    expect(sheet).not.toMatch(/\.woff2?|\.ttf/);
    // The rules that pick a weight or a style keep them, so the alias's faces are chosen by them.
    expect(sheet).toContain(
      `.katex .mathbf{font-family:"${aliases.get('KaTeX_Main')}";font-weight:700}`,
    );
    expect(sheet).toContain(`.katex .textbf{font-weight:700}`);
    expect(sheet).toContain(
      `.katex .mathnormal{font-family:"${aliases.get('KaTeX_Math')}";font-style:italic}`,
    );
  });

  it('refuses a sheet that names a KaTeX family with no alias', () => {
    expect(() => katexSheetText('.x{font-family:KaTeX_Unknown}', new Map())).toThrow(
      /KaTeX_Unknown/,
    );
  });

  it('registers the twenty files under the aliases with their descriptors, once', async () => {
    const aliases = await katexFamilyAliases();
    const hostFace: Face = { family: 'KaTeX_Main', style: 'normal', weight: '400', url: 'host' };
    const page = fakePage([hostFace]);
    const added = registerKatexFaces(katexFontFiles('/k/'), aliases, page);
    expect(added).toHaveLength(20);
    const main = page.faces.filter((f) => f.family === aliases.get('KaTeX_Main'));
    expect(main.map((f) => `${f.style} ${f.weight}`).sort()).toEqual([
      'italic 400',
      'italic 700',
      'normal 400',
      'normal 700',
    ]);
    expect(main.find((f) => f.weight === '700' && f.style === 'normal')?.url).toBe(
      '/k/KaTeX_Main-Bold.woff2',
    );
    // A second editor on the page adds nothing; the host's own KaTeX_Main face stays.
    expect(registerKatexFaces(katexFontFiles('/other/'), aliases, page)).toEqual([]);
    expect(page.faces).toHaveLength(21);
    expect(page.faces[0]).toBe(hostFace);
  });
});
