/**
 * EXP-096 and EXP-105: the converter between LaTeX and Office math (EXP-054 decision 234), tested on
 * its own. Each equation of the allow-list corpus goes LaTeX to tree to Office math, and back through
 * the reader to LaTeX; the result must be the canonical LaTeX of the first tree. Equations the
 * grammar does not cover must be refused, never guessed, and the bounds must hold.
 */
import { describe, expect, it } from 'vitest';
import {
  MATH_LIMITS,
  MathConvertError,
  latexToOmml,
  ommlToLatex,
  parseLatex,
  parseXml,
  toLatex,
} from '../src/index.ts';
import { ALLOWED } from './math-corpus.ts';

const omml = (xml: string) => parseXml(new TextEncoder().encode(xml)).root;

describe('EXP-096 / EXP-105: LaTeX to Office math and back', () => {
  it.each(ALLOWED)('round-trips %s', (latex) => {
    const tree = parseLatex(latex);
    const canonical = toLatex(tree);
    // The canonical form reads back as the same tree.
    expect(toLatex(parseLatex(canonical))).toBe(canonical);
    for (const display of [false, true]) {
      const xml = latexToOmml(latex, display);
      expect(xml.startsWith(display ? '<m:oMathPara ' : '<m:oMath ')).toBe(true);
      expect(ommlToLatex(omml(xml))).toBe(canonical);
    }
  });

  it('writes the elements Word uses', () => {
    const xml = latexToOmml('\\frac{a}{b}', false);
    expect(xml).toBe(
      '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath>',
    );
    expect(latexToOmml('\\sum_{i=1}^n i', false)).toContain(
      '<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr>',
    );
    expect(latexToOmml('\\int_0^1 f', false)).toContain('<m:limLoc m:val="subSup"/>');
    expect(latexToOmml('\\sin x', false)).toContain(
      '<m:rPr><m:sty m:val="p"/></m:rPr><m:t>sin</m:t>',
    );
    expect(latexToOmml('\\text{ab}', false)).toContain('<m:rPr><m:nor/></m:rPr>');
    expect(latexToOmml('\\lim_{x \\to 0} f', false)).toContain('<m:limLow>');
  });

  it('escapes what the text holds', () => {
    const xml = latexToOmml('\\text{a < b}', false);
    expect(xml).toContain('a &lt; b');
    // A character TeX reads is refused in text, not escaped.
    expect(() => latexToOmml('\\text{a & b}', false)).toThrow(MathConvertError);
  });
});

describe('EXP-096 / EXP-105: what is not converted', () => {
  it.each([
    ['a definition', '\\def\\x{1} x'],
    ['an unknown command', '\\foo{x}'],
    ['a package command', '\\rlap{x}'],
    ['an unbalanced group', '\\frac{a}{b'],
    ['a stray closing brace', 'a}'],
    ['an environment off the list', '\\begin{aligned} a &= b \\end{aligned}'],
    ['a mismatched environment', '\\begin{pmatrix} a \\end{bmatrix}'],
    ['cases', '\\begin{cases} a & b \\end{cases}'],
    ['a tilde', 'a~b'],
    ['a percent sign', 'a % b'],
    ['a hash', '#1'],
    ['a double superscript', 'x^1^2'],
    ['a double subscript', 'x_1_2'],
    ['a missing argument', '\\frac{a}'],
    ['text with a backslash', '\\text{a\\b}'],
    ['rows of different widths', '\\begin{matrix} a & b \\\\ c \\end{matrix}'],
    ['\\left without \\right', '\\left( x'],
    ['\\middle', '\\left( x \\middle| y \\right)'],
    ['a non-ASCII letter', 'é'],
    ['\\limits after a letter', 'x\\limits'],
  ])('refuses %s', (_name, latex) => {
    expect(() => latexToOmml(latex, false)).toThrow(MathConvertError);
  });

  it('refuses Office math it has no element for', () => {
    const ns = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
    const refused = [
      `<m:oMath ${ns}><m:eqArr><m:e><m:r><m:t>a</m:t></m:r></m:e></m:eqArr></m:oMath>`,
      `<m:oMath ${ns}><m:sPre><m:sub/><m:sup/><m:e/></m:sPre></m:oMath>`,
      `<m:oMath ${ns}><m:borderBox><m:e/></m:borderBox></m:oMath>`,
      `<m:oMath ${ns}><m:r><m:t>é</m:t></m:r></m:oMath>`,
      `<m:oMath ${ns}><m:nary><m:naryPr><m:chr m:val="Ω"/></m:naryPr><m:e/></m:nary></m:oMath>`,
      `<m:oMath ${ns}><m:acc><m:accPr><m:chr m:val="Ω"/></m:accPr><m:e/></m:acc></m:oMath>`,
      `<m:oMathPara ${ns}><m:oMath/><m:oMath/></m:oMathPara>`,
    ];
    for (const x of refused) expect(() => ommlToLatex(omml(x)), x).toThrow(MathConvertError);
  });

  it('reads the Office math Word writes for what it types', () => {
    const ns = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
    // Word merges the characters of one class into one run, and writes upright function names.
    const sample = `<m:oMath ${ns}><m:r><m:t>x+1=2</m:t></m:r><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>sin</m:t></m:r><m:r><m:t>π</m:t></m:r></m:oMath>`;
    expect(ommlToLatex(omml(sample))).toBe('x+1=2\\sin\\pi');
    // A radical without an index, and a delimiter pair with the default characters.
    const rad = `<m:oMath ${ns}><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad><m:d><m:e><m:r><m:t>y</m:t></m:r></m:e></m:d></m:oMath>`;
    expect(ommlToLatex(omml(rad))).toBe('\\sqrt{x}\\left( y \\right)');
  });
});

describe('EXP-096 / EXP-105: bounds', () => {
  it('refuses an equation longer than the limit', () => {
    expect(() => parseLatex('x'.repeat(MATH_LIMITS.length + 1))).toThrow(MathConvertError);
    expect(() => parseLatex('x'.repeat(MATH_LIMITS.length))).not.toThrow();
  });

  it('refuses nesting deeper than the limit', () => {
    const deep = (n: number): string => '\\frac{'.repeat(n) + 'x' + '}{1}'.repeat(n);
    expect(() => parseLatex(deep(10))).not.toThrow();
    expect(() => parseLatex(deep(MATH_LIMITS.depth + 5))).toThrow(MathConvertError);
    expect(() => parseLatex('{'.repeat(60) + 'x' + '}'.repeat(60))).toThrow(MathConvertError);
  });

  it('refuses Office math with more parts than the limit', () => {
    const ns = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
    const runs = '<m:r><m:t>x</m:t></m:r><m:sSup><m:e/><m:sup/></m:sSup>'.repeat(MATH_LIMITS.nodes);
    expect(() => ommlToLatex(omml(`<m:oMath ${ns}>${runs}</m:oMath>`))).toThrow(MathConvertError);
  });

  it('refuses Office math nested deeper than the limit', () => {
    const ns = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
    const inner = (n: number): string =>
      n === 0
        ? '<m:r><m:t>x</m:t></m:r>'
        : `<m:f><m:num>${inner(n - 1)}</m:num><m:den><m:r><m:t>1</m:t></m:r></m:den></m:f>`;
    expect(() =>
      ommlToLatex(omml(`<m:oMath ${ns}>${inner(MATH_LIMITS.depth + 5)}</m:oMath>`)),
    ).toThrow(MathConvertError);
  });
});
