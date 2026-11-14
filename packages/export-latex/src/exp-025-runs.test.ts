/**
 * Text runs as typed (Node.js only): EXP-025 criteria 1, 2, 4 and 5. Criterion 3 (the extracted text
 * of the exported PDF equals the input for the corpus) needs a compile and is not covered here.
 * The tests read main.tex of the converter's bundle through `blockLines` and the house class from
 * its source; nothing compiles, so the printed PDF is not inspected.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blockLines, doc, para, run, type J } from '../test/docs.ts';

const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;
const CLASS = readFileSync(fileURLToPath(new URL('../class/docedit.cls', import.meta.url)), 'utf8');

/** The TeX of a paragraph's lines, joined so that one macro can be matched across them. */
function tex(lines: string[]): string {
  return lines.join('\n');
}

/** The text payloads of a paragraph's runs (`\DEr{offset}{payload}`), concatenated in order. */
function payloads(lines: string[]): string {
  return lines
    .filter((l) => /^\\DEr\{\d+\}\{/.test(l))
    .map((l) => l.replace(/^\\DEr\{\d+\}\{/, '').replace(/\}%$/, ''))
    .join('');
}

/** The number of spaces a TeX payload stands for: explicit `\ ` and plain spaces alike. */
function spacesIn(p: string): number {
  const explicit = p.split('\\ ').length - 1;
  const plain = p.replace(/\\ /g, '').split(' ').length - 1;
  return explicit + plain;
}

describe('EXP-025 criterion 1: dashes and quotes appear as typed, with TeX ligatures off on every font', () => {
  it('writes --, --- and backtick quotes unchanged into the run text', async () => {
    const p = para('Bold -- ---, `q` and `"`');
    const bundle = await run(doc([p]));
    const all = payloads(blockLines(bundle, idOf(p)));
    expect(all).toBe('Bold -- ---, `q` and `"`');
  });

  it('switches TeX ligatures off in every font loader of the house class, including the fallback', () => {
    // The class loads fonts only through \newfontfamily (the family macro) and \setmainfont.
    const loaders = [
      ...CLASS.matchAll(/\\(?:noexpand\\)?(?:newfontfamily|setmainfont)[\s\S]*?\]\}%/g),
    ].map((m) => m[0]);
    expect(loaders.length).toBeGreaterThanOrEqual(2);
    for (const l of loaders) expect(l).toContain('Ligatures=TeXOff');
    // The fallback renderer option is inside the same bracket, so fallback fonts are covered too.
    expect(loaders.every((l) => l.includes('\\DE@fallbackopt'))).toBe(true);
  });
});

describe('EXP-025 criterion 2: explicit spaces keep the count of the input', () => {
  it('writes every space after the first of a run, and every leading and trailing space, explicitly', async () => {
    const between = para('a   b');
    const lead = para('  lead');
    const trail = para('end  ');
    const single = para('a b');
    const bundle = await run(doc([between, lead, trail, single]));
    expect(payloads(blockLines(bundle, idOf(between)))).toBe('a \\ \\ b');
    expect(payloads(blockLines(bundle, idOf(lead)))).toBe('\\ \\ lead');
    expect(payloads(blockLines(bundle, idOf(trail)))).toBe('end\\ \\ ');
    expect(payloads(blockLines(bundle, idOf(single)))).toBe('a b');
  });

  it('keeps the number of spaces of any text equal to the input (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(fc.constantFrom('a', 'b', '%', '&', ' ', ' ', ' '), { maxLength: 24 })
          .map((a) => a.join('')),
        async (s) => {
          const p = para(`x${s}y`);
          const bundle = await run(doc([p]));
          const body = payloads(blockLines(bundle, idOf(p)));
          expect(body.startsWith('x')).toBe(true);
          expect(body.endsWith('y')).toBe(true);
          expect(spacesIn(body.slice(1, -1))).toBe(s.split(' ').length - 1);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('EXP-025 criterion 4: underline, strike and highlight through lua-ul, colours through xcolor', () => {
  /** A paragraph with one run of the word `word` carrying the marks. */
  const marked = (marks: J[]): J => para('', {}, [{ type: 'text', text: 'word', marks }]);

  it('draws single, double and dotted underline with the class macros, and none with no macro', async () => {
    const single = marked([{ type: 'underline', attrs: { style: 'single' } }]);
    const dbl = marked([{ type: 'underline', attrs: { style: 'double' } }]);
    const dot = marked([{ type: 'underline', attrs: { style: 'dotted' } }]);
    const none = marked([{ type: 'underline', attrs: { style: 'none' } }]);
    const bundle = await run(doc([single, dbl, dot, none]));
    expect(tex(blockLines(bundle, idOf(single)))).toContain('\\DEul{\\DEr{0}{word}}');
    expect(tex(blockLines(bundle, idOf(dbl)))).toContain('\\DEuld{\\DEr{0}{word}}');
    expect(tex(blockLines(bundle, idOf(dot)))).toContain('\\DEulo{\\DEr{0}{word}}');
    const n = tex(blockLines(bundle, idOf(none)));
    expect(n).not.toMatch(/\\DEul/);
    expect(n).toContain('\\DEr{0}{word}');
  });

  it('draws strike with \\DEst and highlight with \\DEhl in the class highlight colour', async () => {
    const strike = marked([{ type: 'strike' }]);
    const hl = marked([{ type: 'highlight', attrs: { value: 'yellow' } }]);
    const bundle = await run(doc([strike, hl]));
    expect(tex(blockLines(bundle, idOf(strike)))).toContain('\\DEst{\\DEr{0}{word}}');
    expect(tex(blockLines(bundle, idOf(hl)))).toContain('\\DEhl{DEhlyellow}{\\DEr{0}{word}}');
  });

  it('writes a colour mark through the colour emitter as a six-digit hex value', async () => {
    const c = marked([{ type: 'color', attrs: { value: '#1F5FAD' } }]);
    const bundle = await run(doc([c]));
    expect(tex(blockLines(bundle, idOf(c)))).toContain('\\DEc{1F5FAD}{\\DEr{0}{word}}');
  });

  it('loads lua-ul and xcolor in the house class, and defines the underline and highlight macros', () => {
    expect(CLASS).toMatch(/\\RequirePackage\{xcolor\}/);
    expect(CLASS).toMatch(/\\RequirePackage\{lua-ul\}/);
    for (const m of ['DEul', 'DEuld', 'DEulo', 'DEst', 'DEhl', 'DEc']) {
      expect(CLASS).toMatch(new RegExp(`\\\\newcommand\\\\${m}\\b`));
    }
  });
});

describe('EXP-025 criterion 5: bold, italic, small caps, all caps and vertical alignment are applied', () => {
  const marked = (marks: J[]): J => para('', {}, [{ type: 'text', text: 'word', marks }]);

  it('sets bold and italic in the font macro, and small caps as the sc shape', async () => {
    const bold = marked([{ type: 'bold' }]);
    const italic = marked([{ type: 'italic' }]);
    const caps = marked([{ type: 'smallCaps' }]);
    const bundle = await run(doc([bold, italic, caps]));
    expect(tex(blockLines(bundle, idOf(bold)))).toMatch(/\\DEfont\{\d+\}\{[^}]+\}\{b\}\{n\}/);
    expect(tex(blockLines(bundle, idOf(italic)))).toMatch(/\\DEfont\{\d+\}\{[^}]+\}\{m\}\{it\}/);
    expect(tex(blockLines(bundle, idOf(caps)))).toMatch(/\\DEfont\{\d+\}\{[^}]+\}\{m\}\{sc\}/);
  });

  it('applies all caps, superscript and subscript with the class macros', async () => {
    const all = marked([{ type: 'allCaps' }]);
    const sup = marked([{ type: 'vertAlign', attrs: { value: 'super' } }]);
    const sub = marked([{ type: 'vertAlign', attrs: { value: 'sub' } }]);
    const bundle = await run(doc([all, sup, sub]));
    expect(tex(blockLines(bundle, idOf(all)))).toContain('\\DEuc{\\DEr{0}{word}}');
    expect(tex(blockLines(bundle, idOf(sup)))).toContain('\\DEsup{\\DEr{0}{word}}');
    expect(tex(blockLines(bundle, idOf(sub)))).toContain('\\DEsub{\\DEr{0}{word}}');
    expect(CLASS).toMatch(/\\newcommand\\DEsub\b/);
  });
});
