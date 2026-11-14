/**
 * SEC-034 — the math gate holds (09 §6.3; EXP-049, EXP-050; invariant I8). The proofs run the real
 * gate of `packages/export-latex`: the lexical scan (`scanMath`) and the full gate (`mathGate`,
 * which adds KaTeX in strict mode, and is the form the converter calls in `blocks.ts`).
 *
 * Criteria covered here: 2 (commands that paint outside their box, and bounded dimensions), 3
 * (unescaped specials and a stray `&`), 4 (display environments, length and nesting). Criterion 1
 * is not ticked: the commit-time run through the room is not exercised here. Criteria 5 and 6 need
 * a compile in the sandbox under Podman and are not ticked (see the story's Notes).
 *
 * The gate is imported by relative path, so this package needs no new dependency.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ALLOW_LIST } from '../../../packages/export-latex/src/math/allow-list.ts';
import {
  DIMENSION_BOUNDS,
  MATH_LIMITS,
  mathGate,
  scanMath,
} from '../../../packages/export-latex/src/math/gate.ts';

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 200);
const ALLOWED_ENVIRONMENTS: ReadonlySet<string> = new Set(ALLOW_LIST.environments);
const ALLOWED_COMMANDS: Readonly<Record<string, string>> = ALLOW_LIST.commands;

/** Commands that paint outside their box or hide content (criterion 2). */
const PAINT_COMMANDS = [
  '\\rlap{x}',
  '\\llap{x}',
  '\\smash{x}',
  '\\raisebox{1em}{x}',
  '\\colorbox{white}{99}',
  '\\fcolorbox{red}{white}{99}',
  '\\rule{1em}{1em}',
  '\\hskip 1pt',
  '\\hspace{-1em}',
  '\\hspace{99em}',
  '\\kern-5pt',
  '\\kern 99cm',
  '\\mkern-3mu',
  '\\mkern 100mu',
];

/** Definitions and primitives (criterion 1; the scan refuses them before KaTeX runs). */
const DEFINITIONS = [
  '\\def\\a{x}',
  '\\let\\a\\b',
  '\\csname a\\endcsname',
  '\\catcode`\\@=11',
  '\\input file',
  '\\include file',
  '\\openin1=file',
  '\\write18{ls}',
  '\\directlua{os.exit()}',
  '\\special{x}',
  '\\immediate x',
  '\\newcommand{\\a}{x}',
  '^^5c input',
  '^^5C\\input',
  '^^^^005c',
];

describe('SEC-034 criterion 2: paint and hide commands are rejected, dimensions are bounded', () => {
  it('rejects every command that paints outside its box or hides content', () => {
    for (const latex of PAINT_COMMANDS) {
      expect(scanMath(latex).ok, latex).toBe(false);
      expect(mathGate(latex, true).ok, latex).toBe(false);
    }
  });

  it('bounds every space command by the ADR 0046 maximum of its unit', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('em', 'ex', 'pt', 'bp', 'mm', 'cm', 'in'),
        fc.integer({ min: 0, max: 400 }),
        (unit, n) => {
          const bound = DIMENSION_BOUNDS[unit]!;
          const accepted = scanMath(`a\\kern ${n}${unit} b`).ok;
          // The bound is a real number; the integer grid decides the inclusive case.
          expect(accepted).toBe(n <= bound);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('bounds the mu space command and refuses stretch or shrink on it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), (n) => {
        expect(scanMath(`a\\mkern ${n}mu b`).ok).toBe(n <= DIMENSION_BOUNDS['mu']!);
      }),
      { numRuns: RUNS },
    );
    expect(scanMath('a\\mkern 2mu plus 1mu b').ok).toBe(false);
  });

  it('refuses a \\hspace whose argument is negative, not braced, or over the bound', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), (n) => {
        expect(scanMath(`\\hspace{-${n}pt}`).ok).toBe(false);
        expect(scanMath(`\\hspace{${n}em}`).ok).toBe(n <= DIMENSION_BOUNDS['em']!);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('SEC-034 criterion 3: unescaped specials and stray ampersands are rejected', () => {
  it('rejects an unescaped %, #, ~ or $ anywhere in an otherwise valid equation', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z+=]{0,20}$/),
        fc.constantFrom('%', '#', '~', '$'),
        fc.nat(20),
        (base, special, at) => {
          const pos = Math.min(at, base.length);
          const latex = base.slice(0, pos) + special + base.slice(pos);
          expect(scanMath(latex).ok).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('accepts the same specials once escaped', () => {
    expect(scanMath('50\\% + \\# + \\$').ok).toBe(true);
  });

  it('rejects a stray & outside an alignment environment, and accepts it inside one', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z ]{0,10}$/), (base) => {
        expect(scanMath(`${base}&${base}`).ok).toBe(false);
        expect(scanMath(`\\begin{aligned}${base}&${base}\\end{aligned}`).ok).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('rejects \\text{50% of} and any percent sign inside a text command', () => {
    expect(scanMath('\\text{50% of}').ok).toBe(false);
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z ]{0,10}$/), (word) => {
        expect(scanMath(`\\text{${word}%}`).ok).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('SEC-034 criterion 4: environments, length and nesting are bounded', () => {
  it('rejects every display environment other than the allowed ones, equation included', () => {
    for (const env of ['equation', 'align', 'tabular', 'array', 'verbatim', 'figure']) {
      expect(ALLOWED_ENVIRONMENTS.has(env), env).toBe(false);
      expect(scanMath(`\\begin{${env}}x\\end{${env}}`).ok, env).toBe(false);
    }
  });

  it('accepts each allowed environment with the content it is meant for', () => {
    for (const env of ['aligned', 'gathered', 'cases', 'matrix', 'pmatrix']) {
      expect(scanMath(`\\begin{${env}}a&b\\\\c&d\\end{${env}}`).ok, env).toBe(true);
    }
  });

  it('rejects input over 4,000 characters and accepts input at the limit', () => {
    expect(MATH_LIMITS.length).toBe(4000);
    expect(scanMath('x'.repeat(MATH_LIMITS.length)).ok).toBe(true);
    expect(scanMath('x'.repeat(MATH_LIMITS.length + 1)).ok).toBe(false);
  });

  it('rejects nesting deeper than 50 and accepts nesting of exactly 50', () => {
    const nest = (n: number) => '{'.repeat(n) + 'x' + '}'.repeat(n);
    expect(scanMath(nest(MATH_LIMITS.depth)).ok).toBe(true);
    expect(scanMath(nest(MATH_LIMITS.depth + 1)).ok).toBe(false);
  });
});

describe('SEC-034 commit-time and converter refusal of definitions (criterion 1, lexical part)', () => {
  it('the lexical scan refuses every definition and primitive of the corpus', () => {
    for (const latex of DEFINITIONS) {
      expect(scanMath(latex).ok, latex).toBe(false);
    }
  });

  it('the allow-list holds no definition, file, shell or paint primitive', () => {
    const forbidden = [
      'def',
      'let',
      'csname',
      'catcode',
      'input',
      'include',
      'openin',
      'write',
      'directlua',
      'special',
      'immediate',
      'newcommand',
      'rlap',
      'llap',
      'smash',
      'raisebox',
      'colorbox',
      'fcolorbox',
      'rule',
      'hskip',
    ];
    for (const name of forbidden) {
      expect(Object.hasOwn(ALLOWED_COMMANDS, name), name).toBe(false);
    }
  });
});
