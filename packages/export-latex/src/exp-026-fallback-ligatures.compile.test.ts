/**
 * EXP-026 criterion 5, the ligature half (lane w2, 2026-11-15): the fallback face draws with TeX
 * ligatures off.
 *
 * The earlier compile test (`exp-026-fallback.compile.test.ts`) could not isolate this, because
 * "--" and the backticks are in every family of the image, so the family draws them and the
 * fallback face never sees them. This test asks the engine for the font instance that the fallback
 * chain really used, and typesets the ligature inputs in that instance:
 *
 * 1. The converter's output is compiled with a probe added to `main.tex` (the class, the styles and
 *    the body are untouched). The probe sets U+2200 in family 1 in a box. The family lacks that
 *    character, so the fallback chain draws it; the probe reads the font id of that glyph node.
 * 2. It then selects that font id (`\setfontid`) and sets `A--B` and two backticks and two
 *    apostrophes around `C`. With ligatures off they reach the PDF as typed.
 * 3. A control line sets the same input in the same font file loaded with `Ligatures=TeX`. It must
 *    come out with an en dash and curly quotes, which shows that the face has those ligature rules
 *    and that the check can tell the two cases apart.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
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

/** TeX added before `\DEendsections`: finds the fallback font instance and typesets in it. */
function probe(fallbackFile: string): string {
  return [
    '\\par\\setbox0\\hbox{\\csname DE@fam@1\\endcsname ∀}%',
    '\\directlua{',
    '  local id = -1',
    '  for n in node.traverse(tex.box[0].head) do',
    '    if n.id == node.id("glyph") then',
    '      if n.char == 0x2200 then id = n.font end',
    '    end',
    '  end',
    '  token.set_macro("DEprobefont", tostring(id))',
    '  local f = id >= 0 and font.getfont(id) or nil',
    '  texio.write_nl("log", "DEPROBE fallback id=" .. id .. " name=" .. (f and f.name or "none"))',
    '}%',
    '\\setbox2\\hbox{\\csname DE@fam@1\\endcsname x}%',
    '\\directlua{',
    '  for n in node.traverse(tex.box[2].head) do',
    '    if n.id == node.id("glyph") then',
    '      texio.write_nl("log", "DEPROBE family id=" .. n.font)',
    '    end',
    '  end',
    '}%',
    "{\\setfontid\\DEprobefont\\relax FB:A--B``C''}\\par",
    `{\\fontspec{${fallbackFile}}[Path=\\csname DE@fontpath\\endcsname, Ligatures=TeX]CT:A--B\`\`C''}\\par`,
    '',
  ].join('\n');
}

describe.skipIf(!ready)('EXP-026 criterion 5: the fallback face draws with ligatures off', () => {
  it('keeps "--" and the quote marks as typed in the font instance of the fallback chain', async () => {
    const name = 'exp-026-fallback-ligatures';
    const fonts = await imageFonts();
    const body: J[] = [para('For all ∀ x')];
    const bundle = await convert(doc(body), {
      fonts,
      classFiles: classFiles(),
      profile: 'final',
      title: name,
      instant: INSTANT,
      timeZone: 'Europe/London',
      suggestions: 'accept',
    } as never);
    // The fallback chain of this manifest is the math face (no fallback list in the manifest).
    const fallback = /\\DEfallback\{([0-9a-f]+\.[a-z]+)\}/.exec(bundle.files['styles.tex']!);
    expect(fallback, 'styles.tex declares a fallback face').not.toBeNull();
    const main = bundle.files['main.tex']!;
    expect(main).toContain('\\DEendsections');
    const probed = {
      ...bundle,
      files: {
        ...bundle.files,
        'main.tex': main.replace('\\DEendsections', `${probe(fallback![1]!)}\\DEendsections`),
      },
    };
    const c = await compileBundle(probed);
    const dir = keep(name, c);
    expect(c.compile.ok, `the final compile must pass (${dir})`).toBe(true);
    expect(c.compile.log).not.toMatch(/Missing character/i);

    // The glyph of U+2200 was drawn by another font instance than the family's own.
    const fb = /DEPROBE fallback id=(-?\d+) name=(\S+)/.exec(c.compile.log);
    const fam = /DEPROBE family id=(\d+)/.exec(c.compile.log);
    expect(fb, `the probe line is in the log (${dir})`).not.toBeNull();
    expect(fam).not.toBeNull();
    expect(Number(fb![1])).toBeGreaterThan(0);
    expect(fb![1]).not.toBe(fam![1]);
    // That instance is the fallback face of styles.tex, requested with TeX ligatures off.
    expect(fb![2]).toContain(fallback![1]!);
    expect(fb![2]).toContain('-tlig');

    const out = pdfText(c.compile.pdf!);
    expect(out).not.toBeNull();
    const lines = out!.split(/\r?\n/).map((l) => l.trim());
    // In the fallback instance the input is printed as typed.
    expect(lines).toContain("FB:A--B``C''");
    // The control: the same face with TeX ligatures on makes an en dash and curly quotes.
    expect(lines).toContain('CT:A–B“C”');
  }, 300_000);
});
