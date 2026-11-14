/**
 * EXP-047 criterion 1, the part the converter controls (Node.js only): every font that `styles.tex`
 * and the house class load is named by a content-hash file name and given by path (`Path=`), never
 * by a family or system name. The read-only directory and the worker's own loading are in
 * services/export-worker (src/font-files.ts) and are not checked here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { doc, FONTS, para, run, CLASS_FILES } from '../test/docs.ts';

/** The house class as shipped, not the stub the other converter tests use. */
const REAL_CLASS = readFileSync(new URL('../class/docedit.cls', import.meta.url), 'utf8');

const HASH_FILE = /^[0-9a-f]{64}\.(?:ttf|otf|ttc|otc)$/;
const FONT_MACROS = /\\DE(?:deffamily|mainfont|mathfont|fallback)\b/;

/** The braced arguments of a line that are file names (they contain a dot). */
function fileArgs(line: string): string[] {
  return [...line.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!).filter((a) => a.includes('.'));
}

describe('EXP-047 criterion 1: fonts are named by hash and given by path', () => {
  it('names every face in styles.tex by its content-hash file name', async () => {
    const bundle = await run(doc([para('Text.', {})]), { fonts: FONTS, classFiles: CLASS_FILES });
    const lines = bundle.files['styles.tex']!.split('\n').filter((l) => FONT_MACROS.test(l));
    const names = lines.flatMap(fileArgs);
    // Every family has four faces and the math face is always named.
    expect(names.length).toBeGreaterThanOrEqual(4 * FONTS.families.length + 1);
    for (const n of names) expect(n).toMatch(HASH_FILE);
  });

  it('gives every font in the class by Path=\\DE@fontpath, and names none by family', async () => {
    const lines = REAL_CLASS.split('\n');
    const loaders = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /\\(?:newfontfamily|setmainfont|setmathfont)\b/.test(l));
    expect(loaders.length).toBeGreaterThanOrEqual(3);
    for (const { i } of loaders) {
      // The option list of a loader may run over the next lines; look three lines on.
      const window = lines.slice(i, i + 3).join(' ');
      expect(window).toContain('Path=\\DE@fontpath');
    }
    // The only names a loader takes are macro arguments, filled by the converter with hash files.
    for (const { l } of loaders) {
      const name = /\\(?:newfontfamily\\[^{]*|setmainfont|setmathfont)\{([^}]*)\}/.exec(l)?.[1];
      if (name !== undefined) expect(name).toMatch(/^#\d$/);
    }
  });

  it('never names a font by system lookup (Name=, Extension= or a family name) in styles.tex', async () => {
    const bundle = await run(doc([para('Text.', {})]), { fonts: FONTS, classFiles: CLASS_FILES });
    const styles = bundle.files['styles.tex']!;
    expect(styles).not.toMatch(/\bName=/);
    expect(styles).not.toMatch(/\bExtension=/);
    for (const f of FONTS.families) expect(styles).not.toContain(f.name);
    expect(styles).not.toContain(FONTS.math.name);
  });

  it('writes no font loader into main.tex (the faces are set once, in styles.tex and the class)', async () => {
    const bundle = await run(doc([para('Text.', {})]), { fonts: FONTS, classFiles: CLASS_FILES });
    expect(bundle.files['main.tex']!).not.toMatch(
      /\\(?:setmainfont|setmathfont|newfontfamily|fontspec)\b/,
    );
  });
});
