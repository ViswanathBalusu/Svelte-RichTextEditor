import { describe, expect, it } from 'vitest';
import { ALLOW_LIST } from './allow-list.ts';
import { DIMENSION_BOUNDS, MATH_LIMITS, mathGate, scanMath } from './gate.ts';
import { katexRejects } from './katex.ts';

/** The refusal reason of a value, or null when the gate accepts it. */
const refusal = (latex: string, display = false): string | null => {
  const r = mathGate(latex, display);
  return r.ok ? null : r.reason;
};

const COMMANDS: Readonly<Record<string, string>> = ALLOW_LIST.commands;

describe('math gate: syntax and KaTeX (EXP-049 criterion 1)', () => {
  it('lets KaTeX reject what the lexical scan passes', () => {
    // `\frac` is on the allow-list, so only KaTeX sees the missing second argument.
    expect(scanMath('\\frac{1}').ok).toBe(true);
    expect(refusal('\\frac{1}')).toMatch(/^KaTeX: /);
  });

  it('accepts an ordinary expression and a display expression', () => {
    expect(refusal('x^2 + \\alpha_1 \\le \\sum_{i=1}^{n} i')).toBeNull();
    expect(refusal('\\frac{a}{b}', true)).toBeNull();
  });
});

describe('math gate: allow-list (EXP-049 criterion 2)', () => {
  it('refuses a command that KaTeX supports but the allow-list does not', () => {
    // `\cancel` is parsed by KaTeX 0.19.1 (checked below) and is not an entry of the allow-list.
    expect(COMMANDS.cancel).toBeUndefined();
    expect(katexRejects('\\cancel{x}', false)).toBeNull();
    expect(refusal('\\cancel{x}')).toMatch(/\\cancel is not on the allow-list/);
  });

  it('never reports a listed name as off the allow-list', () => {
    const names = Object.keys(COMMANDS);
    for (const name of names.slice(0, 200)) {
      const r = scanMath(`\\${name}`);
      // A command that takes arguments may fail the scan for want of them; a listed name must
      // never be refused as "not on the allow-list".
      if (!r.ok) expect(r.reason).not.toMatch(/is not on the allow-list/);
    }
  });
});

describe('math gate: forbidden primitives (EXP-049 criterion 3)', () => {
  const forbidden = [
    '\\def\\a{b}',
    '\\let\\a=b',
    '\\csname x\\endcsname',
    '\\catcode`\\a=12',
    '\\input file',
    '\\include file',
    '\\openin1=file',
    '\\write18{ls}',
    '\\directlua{os.exit()}',
    '\\special{x}',
    '\\immediate\\write',
    '\\newcommand\\a{b}',
    '\\write 1{x}',
  ];

  it.each(forbidden)('refuses %s in every position', (latex) => {
    expect(refusal(latex)).not.toBeNull();
    expect(refusal(`x ${latex} y`)).not.toBeNull();
    expect(refusal(`{${latex}}`)).not.toBeNull();
  });

  it('refuses the same primitives with the spacing TeX allows after a control word', () => {
    expect(refusal('\\def \\a{b}')).not.toBeNull();
    expect(refusal('\\input\tfile')).not.toBeNull();
    expect(refusal('\\input\nfile')).not.toBeNull();
  });

  it('refuses the caret notation for any character', () => {
    expect(refusal('^^5c')).toMatch(/\^\^ notation/);
    expect(refusal('\\^^5cdef')).toMatch(/\^\^/);
    expect(refusal('^^5Cinput')).toMatch(/\^\^/);
  });
});

describe('math gate: indirect construction (EXP-049 criterion 4)', () => {
  it.each([
    '\\expandafter\\def\\csname a\\endcsname{x}',
    '\\expandafter\\input\\jobname',
    '\\edef\\a{\\input}',
    '\\noexpand\\input',
    '\\string\\input',
  ])('refuses %s because the indirect builder is not on the allow-list', (latex) => {
    expect(refusal(latex)).not.toBeNull();
  });
});

describe('math gate: allow-list data (EXP-049 criterion 5, part)', () => {
  it('has only commands of the allowed arities, and environments that the gate knows', () => {
    const arities = new Set(['symbol', 'arg', 'args2', 'delimiter', 'sized', 'dimen', 'muskip']);
    for (const arity of Object.values(COMMANDS)) expect(arities.has(arity)).toBe(true);
    expect(ALLOW_LIST.environments.length).toBeGreaterThan(0);
    expect(ALLOW_LIST.version).toBe(1);
  });
});

describe('math gate: painting, dimensions, characters and limits (EXP-050)', () => {
  it.each([
    '\\rlap{x}',
    '\\llap{x}',
    '\\smash{x}',
    '\\raisebox{1pt}{x}',
    '\\colorbox{white}{5}',
    '\\fcolorbox{red}{white}{x}',
    '\\rule{1pt}{1pt}',
  ])('rejects %s, which paints outside its box or hides other content (criterion 1)', (latex) => {
    expect(refusal(latex)).not.toBeNull();
    expect(refusal(latex, true)).not.toBeNull();
  });

  it('rejects a white box over a price in another region (criterion 6)', () => {
    expect(refusal('\\colorbox{white}{99}')).not.toBeNull();
    expect(refusal('\\colorbox{white}{\\text{Price}}')).not.toBeNull();
  });

  it('rejects negative, large and unbounded space arguments (criterion 2)', () => {
    expect(refusal('a\\kern-1pt b')).not.toBeNull();
    expect(refusal(`a\\kern${DIMENSION_BOUNDS.pt! + 1}pt b`)).not.toBeNull();
    expect(refusal('a\\hskip 1pt b')).not.toBeNull();
    expect(refusal('a\\hspace{-1em} b')).not.toBeNull();
    expect(refusal('a\\hspace{3em} b')).not.toBeNull();
    expect(refusal('a\\hspace{1em} b')).toBeNull();
    expect(refusal('a\\kern 5pt b')).toBeNull();
    expect(refusal('a\\mkern 9999mu b')).not.toBeNull();
    expect(refusal('a\\mskip 6mu plus 3mu b')).not.toBeNull();
  });

  it('rejects an unescaped %, #, ~ and a stray & (criterion 3)', () => {
    expect(refusal('\\text{50% of}')).not.toBeNull();
    expect(refusal('a%b')).toMatch(/unescaped %/);
    expect(refusal('a#b')).toMatch(/unescaped #/);
    expect(refusal('a~b')).toMatch(/unescaped ~/);
    expect(refusal('a&b')).toMatch(/& outside/);
  });

  it('accepts escaped specials, and & and \\\\ inside an alignment environment (criterion 3)', () => {
    expect(refusal('a\\%b\\#c\\&d')).toBeNull();
    expect(refusal('\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}')).toBeNull();
  });

  it('allows aligned, gathered, cases and the matrix environments, and no others (criterion 4)', () => {
    expect(refusal('\\begin{aligned} a &= b \\end{aligned}', true)).toBeNull();
    expect(refusal('\\begin{gathered} a \\\\ b \\end{gathered}', true)).toBeNull();
    expect(refusal('\\begin{cases} a & b \\\\ c & d \\end{cases}', true)).toBeNull();
    expect(refusal('\\begin{pmatrix} a & b \\end{pmatrix}', true)).toBeNull();
    for (const env of ['align', 'align*', 'gather', 'multline', 'eqnarray', 'equation']) {
      expect(refusal(`\\begin{${env}} a \\end{${env}}`, true)).not.toBeNull();
    }
  });

  it('bounds the length at 4,000 characters and the nesting depth at 50 (criterion 5)', () => {
    expect(MATH_LIMITS).toEqual({ length: 4000, depth: 50 });
    expect(refusal('x'.repeat(4000))).toBeNull();
    expect(refusal('x'.repeat(4001))).toMatch(/4,000/);
    expect(refusal('{'.repeat(50) + 'x' + '}'.repeat(50))).toBeNull();
    expect(refusal('{'.repeat(51) + 'x' + '}'.repeat(51))).toMatch(/nesting/);
  });
});
