/**
 * Missing glyphs at compile time (Node.js only, sandbox): EXP-026 criteria 2 and 5. The bundles are
 * compiled in the export worker's sandbox (Podman) through `test/harness.ts`.
 *
 * - Criterion 2: the class sets `\tracinglostchars=3` in the final profile, so a character that the
 *   converter's check let through and that no font provides makes the compile fail. The converter's
 *   check is given a manifest that claims the private-use character U+E000 for every face (the real
 *   faces do not cover it), so the converter passes it and LuaTeX must catch it. The positive
 *   control is the same document with a character the real faces cover, which compiles.
 * - Criterion 5 (the part that is tested here): a final export in which every character is covered
 *   by a face passes and produces a PDF whose text is the input. The ligature setting of fallback
 *   faces is not checked here, so criterion 5 stays unticked.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 * Work of lane U-EXP-017-032.
 */
import { describe, expect, it } from 'vitest';
import { convert, type FontManifest } from '../src/index.ts';
import { doc, para, type J } from '../test/docs.ts';
import {
  classFiles,
  compileBundle,
  imageFonts,
  keep,
  pdfText,
  sandboxReady,
} from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** The final-profile options of a single-document job. */
const OPTIONS = (title: string) => ({
  profile: 'final' as const,
  title,
  instant: INSTANT,
  timeZone: 'Europe/London',
  suggestions: 'accept' as const,
});

/** A copy of the image's manifest that claims the code point for every face, real or not. */
async function claiming(cp: number): Promise<FontManifest> {
  const real = await imageFonts();
  const claim = <T extends object>(f: T): T => ({ ...f, coverage: [[cp, cp]] as never });
  return {
    ...real,
    families: real.families.map((f) => ({
      ...f,
      regular: claim(f.regular),
      bold: claim(f.bold),
      italic: claim(f.italic),
      boldItalic: claim(f.boldItalic),
    })),
    math: claim(real.math),
  };
}

const body = (text: string): J[] => [para(text)];

describe.skipIf(!ready)(
  'EXP-026 criterion 2: a character lost at compile time is an error in the final profile',
  () => {
    it('fails the compile when a character the converter let through is missing from every face', async () => {
      const name = 'exp-026-lost-char';
      // U+4E00 is kept by the converter (U+E000 is dropped from the text before the compile), and no
      // face of the image has it, so it is lost at compile time.
      const bundle = await convert(doc(body('before 一 after')), {
        fonts: await claiming(0x4e00),
        classFiles: classFiles(),
        ...OPTIONS(name),
      } as never);
      const c = await compileBundle(bundle);
      const dir = keep(name, c);
      expect(c.compile.ok, `the final compile must fail (${dir})`).toBe(false);
      expect(c.compile.log).toMatch(/Missing character/i);
    }, 300_000);

    it('compiles the same document when every character is covered by a real face (positive control)', async () => {
      const name = 'exp-026-covered-char';
      const bundle = await convert(doc(body('Привет, мир')), {
        fonts: await imageFonts(),
        classFiles: classFiles(),
        ...OPTIONS(name),
      } as never);
      const c = await compileBundle(bundle);
      const dir = keep(name, c);
      expect(c.compile.ok, `the compile must pass (${dir})`).toBe(true);
      expect(c.compile.log).not.toMatch(/Missing character/i);
      const text = pdfText(c.compile.pdf!);
      expect(text).not.toBeNull();
      expect(text!.replace(/\s+$/, '')).toBe('Привет, мир');
    }, 300_000);
  },
);
