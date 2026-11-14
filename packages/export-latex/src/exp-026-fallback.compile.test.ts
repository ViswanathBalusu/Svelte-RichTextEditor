/**
 * EXP-026 criterion 5, the part that a compile can show (lane V-EXP-017-032): a final export in
 * which every character is covered by a font or by the fallback chain passes, and the text is
 * printed as typed. The character U+2200 (for all) is not in the Noto families of the image, so it
 * is drawn by the fallback chain, which is the math face when the manifest has no fallback list
 * (`convert.ts`, `\DEfallback`). The text also holds "--" and two backticks, which TeX ligatures
 * would turn into an en dash and curly quotes; the class sets `Ligatures=TeXOff` on the families
 * and `-tlig` on the fallback faces, so they must come out as typed.
 *
 * This does not isolate the fallback face's ligature setting: "--" and the backticks are drawn by
 * the family, not by the fallback. Criterion 5 stays unticked for that reason (see the story Notes).
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 * Work of lane V-EXP-017-032.
 */
import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.ts';
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

describe.skipIf(!ready)(
  'EXP-026 criterion 5: a fallback-covered character passes a final export',
  () => {
    it('compiles, and prints the text as typed, when the fallback chain draws one character', async () => {
      const name = 'exp-026-fallback-char';
      const text = "For all ∀ x -- y ``quoted''";
      const body: J[] = [para(text)];
      const bundle = await convert(doc(body), {
        fonts: await imageFonts(),
        classFiles: classFiles(),
        profile: 'final',
        title: name,
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      const c = await compileBundle(bundle);
      const dir = keep(name, c);
      expect(c.compile.ok, `the final compile must pass (${dir})`).toBe(true);
      expect(c.compile.log).not.toMatch(/Missing character/i);
      const out = pdfText(c.compile.pdf!);
      expect(out).not.toBeNull();
      // "--" stays two hyphens and the backticks stay as typed (no en dash, no curly quotes).
      expect(out!.replace(/\s+/g, ' ').trim()).toBe(text);
    }, 300_000);
  },
);
