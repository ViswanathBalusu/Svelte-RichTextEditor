// FE-069 criterion 3, Node.js half: every hash in the KaTeX font manifest is the SHA-256 of the file
// the installed katex package ships, and no source of the element but katex-fonts.ts imports KaTeX's
// stylesheet (whose @font-face rules would register the fonts by family name instead).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fontAlias } from './font-registration.ts';
import { KATEX_FONT_ROWS, katexFontFiles } from './katex-font-manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fontsDir = join(here, '..', 'node_modules', 'katex', 'dist', 'fonts');

describe('KaTeX font manifest (FE-069 criterion 3)', () => {
  it('lists the twenty woff2 files of the installed katex package, each with its SHA-256', () => {
    const onDisk = readdirSync(fontsDir)
      .filter((n) => n.endsWith('.woff2'))
      .sort();
    expect(onDisk.length).toBe(20);
    expect(KATEX_FONT_ROWS.map((r) => r.file).sort()).toEqual(onDisk);
    for (const row of KATEX_FONT_ROWS) {
      const digest = createHash('sha256')
        .update(readFileSync(join(fontsDir, row.file)))
        .digest('hex');
      expect(digest, row.file).toBe(row.hash);
    }
  });

  it('gives every file a distinct hash alias and no alias carries a KaTeX family name', () => {
    const entries = katexFontFiles('/fonts/');
    const aliases = entries.map((e) => fontAlias(e.hash));
    expect(new Set(aliases).size).toBe(entries.length);
    expect(aliases.every((a) => !a.includes('KaTeX'))).toBe(true);
    expect(entries.every((e) => e.url.startsWith('/fonts/') && e.url.endsWith('.woff2'))).toBe(
      true,
    );
  });

  it('imports the KaTeX stylesheet only in katex-fonts.ts, which removes its @font-face rules', () => {
    const srcDir = here;
    const offenders: string[] = [];
    for (const name of readdirSync(srcDir)) {
      if (!/\.(ts|svelte)$/.test(name) || name.endsWith('.test.ts')) continue;
      // katex-fonts.ts strips every @font-face rule before the sheet is adopted (katex-fonts.test.ts).
      if (name === 'katex-fonts.ts') continue;
      const text = readFileSync(join(srcDir, name), 'utf8');
      if (/katex(\.min)?\.css|katex\/dist\/katex/.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
    expect(existsSync(fontsDir)).toBe(true);
  });
});
