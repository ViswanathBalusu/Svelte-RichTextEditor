/**
 * SEC-034 criterion 6 (10 §3.4; 09 §6.3): the fuzz target of the math gate, compiled in the sandbox.
 *
 * The target builds random equations from the gate's own allow-list (`ALLOW_LIST`, with the sample
 * use of each command from `candidates.ts`): symbols and commands nested in fractions, radicals,
 * scripts, delimiters, groups and a matrix, with spaces at their bounds. fast-check draws them
 * with a fixed seed, and only those the gate accepts are kept, so the batch is "every accepted
 * input" of that run. The extremes the gate accepts are added: 4000 characters, nesting of 50,
 * and the strongest equation of SEC-034 criterion 5.
 *
 * One document holds the accepted batch, one inline equation in each paragraph. It is converted
 * (no equation may be refused) and compiled in the real sandbox with `\tracingcommands1` switched
 * on after the class line. The checks:
 *
 * - the compile succeeds inside the job limits: no time-out, no output overflow, a PDF, and a wall
 *   time under the limit of the job;
 * - the trace is clean: of the commands TeX executes in math mode, the ones this document adds to
 *   a baseline document (the same number of equations, each `x`) include no primitive that reads
 *   or writes a file, runs Lua, changes a category code or defines a macro, and none outside the
 *   list of math and box primitives recorded here (EXPECTED_ADDED).
 *
 * The trace is at level 1 of `\tracingcommands`: it shows the unexpandable commands TeX executes,
 * which are the ones that can act, and not the expansion of macros.
 *
 * The same document holds the corpus of refused definitions and primitives of criterion 1. Each
 * is replaced by the visible placeholder `[equation]` with a `math_refused` diagnostic, and none
 * of its text is in `main.tex`.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { convert } from './index.ts';
import { ALLOW_LIST } from './math/allow-list.ts';
import { CANDIDATES, sample, type Candidate } from './math/candidates.ts';
import { mathGate, MATH_LIMITS } from './math/gate.ts';
import { doc, para, type J } from '../test/docs.ts';
import {
  classFiles,
  compileBundle,
  firstError,
  imageFonts,
  pdfText,
  sandboxReady,
} from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const OPTIONS = {
  profile: 'preview',
  instant: '2026-11-06T10:00:00.000Z',
  timeZone: 'Europe/London',
  suggestions: 'accept',
} as const;

const RANDOM_RUNS = 400;
/** The time limit of a job, seconds (09 §9.3; SEC-035 criterion 2). */
const JOB_SECONDS = 120;

const ALLOWED: Candidate[] = Object.keys(ALLOW_LIST.commands).map((name) => {
  const c = CANDIDATES.find((x) => x.name === name);
  if (!c) throw new Error(`no candidate named ${name}`);
  return c;
});

/** Random equations over the allow-list. */
const equation: fc.Arbitrary<string> = fc.letrec<{ e: string }>((tie) => ({
  e: fc.oneof(
    { maxDepth: 5, withCrossShrink: true },
    fc.constantFrom(...'abxyzn0123'),
    fc.constantFrom(...ALLOWED).map(sample),
    fc.constantFrom('\\hspace{2em}', '\\mkern36mu', '\\kern 22pt', '\\,', '\\quad'),
    fc.tuple(tie('e'), tie('e')).map(([a, b]) => `{${a} ${b}}`),
    fc.tuple(tie('e'), tie('e')).map(([a, b]) => `\\frac{${a}}{${b}}`),
    tie('e').map((a) => `\\sqrt{${a}}`),
    fc.tuple(tie('e'), tie('e')).map(([a, b]) => `{${a}}^{${b}}`),
    fc.tuple(tie('e'), tie('e')).map(([a, b]) => `{${a}}_{${b}}`),
    tie('e').map((a) => `\\left( ${a} \\right)`),
    fc
      .tuple(tie('e'), tie('e'), tie('e'), tie('e'))
      .map(([a, b, c, d]) => `\\begin{pmatrix} ${a} & ${b} \\\\ ${c} & ${d} \\end{pmatrix}`),
  ),
})).e;

function nested(depth: number, leaf: string): string {
  let f = leaf;
  for (let i = 0; i < depth; i++) f = `\\frac{${f}}{\\sqrt{${f}}}`;
  return f;
}

/** The extremes the gate accepts. */
const EXTREMES: readonly string[] = [
  'x'.repeat(MATH_LIMITS.length),
  `${'{'.repeat(MATH_LIMITS.depth - 1)}x${'}'.repeat(MATH_LIMITS.depth - 1)}`,
  `\\hspace{2em}\\bigg[\\bigg(${nested(6, 'x')}\\bigg)\\bigg]^{\\hspace{22pt}}\\mkern36mu\\text{GBP 1,000,000 per month}\\hspace{2em}`,
];

/** The accepted batch: the extremes and every sample of the fixed-seed run that the gate accepts. */
function accepted(): string[] {
  const drawn = fc.sample(equation, { seed: 34, numRuns: RANDOM_RUNS });
  return [...new Set([...EXTREMES, ...drawn])].filter((s) => mathGate(s, false).ok);
}

/** The corpus of criterion 1: definitions and primitives, refused by the gate. */
const REFUSED: readonly string[] = [
  '\\def\\x{SECDEF}',
  '\\let\\x\\SECLET',
  '\\csname SECCSNAME\\endcsname',
  '\\catcode`\\@=11 SECCATCODE',
  '\\input{SECINPUT}',
  '\\include{SECINCLUDE}',
  '\\openin5=SECOPENIN',
  '\\write18{SECWRITE}',
  '\\directlua{SECLUA()}',
  '\\special{SECSPECIAL}',
  '\\immediate\\write16{SECIMMEDIATE}',
  '\\newcommand{\\x}{SECNEWCOMMAND}',
  '^^5cinput SECCARET',
];

/** Primitives that read or write files, run Lua, change category codes or define macros. */
const FORBIDDEN_IN_MATH = [
  '\\input',
  '\\endinput',
  '\\openin',
  '\\closein',
  '\\read',
  '\\readline',
  '\\openout',
  '\\closeout',
  '\\write',
  '\\immediate',
  '\\special',
  '\\directlua',
  '\\latelua',
  '\\catcode',
  '\\scantokens',
  '\\scantextokens',
  '\\shipout',
  '\\def',
  '\\gdef',
  '\\edef',
  '\\xdef',
  '\\let',
];

/**
 * What the batch may add to the baseline's math-mode commands: the primitives that typeset math
 * and boxes, and `\futurelet`, with which the allowed macros look ahead for an optional argument
 * or a star (`\sqrt`, `\\` in a matrix). A command outside this list fails the test, so that a new
 * one is looked at before it is accepted.
 */
const EXPECTED_ADDED = new Set(
  (
    'Udelimiter Umathaccent Umathchar Umathcode Uradical Ustack Uvextensible abovewithdelims ' +
    'afterassignment box cleaders displaylimits displaystyle endlocalcontrol fam futurelet hbox ' +
    'hskip ignorespaces kern left limits mathbin mathclose mathinner mathop mathopen mathord ' +
    'mathrel mathsurround medmuskip mkern mskip nolimits nonscript over penalty right ' +
    'scriptscriptstyle scriptstyle setbox skip textstyle thickmuskip thinmuskip toks wd'
  )
    .split(' ')
    .map((n) => `\\${n}`),
);

/** Converts the body, switches the trace on after the class line, and compiles it. */
async function compileTraced(title: string, body: J[]) {
  const bundle = await convert(doc(body), {
    fonts: await imageFonts(),
    classFiles: classFiles(),
    ...OPTIONS,
    title,
  } as never);
  const main = bundle.files['main.tex'];
  if (typeof main !== 'string') throw new Error('no main.tex');
  const traced = main.replace(
    /\\documentclass\[[^\]]*\]\{docedit\}/,
    (m) => `${m}\\tracingonline1 \\tracingcommands1 `,
  );
  if (traced === main) throw new Error('main.tex has no docedit class line');
  bundle.files['main.tex'] = traced;
  return { main, compiled: await compileBundle(bundle) };
}

/**
 * The control sequences TeX executed in math mode, from a level 1 trace. Each entry of the trace is
 * a line `{command}` or `{mode: command}`; an entry with a mode changes the current mode. TeX wraps
 * a log line after 79 characters, so a line of that length is joined to the next one.
 */
function mathModeCommands(log: string): { names: Set<string>; entries: number } {
  let joined = '';
  for (const line of log.split('\n')) joined += line.length === 79 ? line : `${line}\n`;
  const names = new Set<string>();
  let mode = '';
  let entries = 0;
  for (const line of joined.split('\n')) {
    const m = /^\{(.*)\}$/.exec(line.trim());
    if (!m) continue;
    let command = m[1]!;
    const switched = /^((?:[a-z]+ )+mode): (.*)$/.exec(command);
    if (switched) {
      mode = switched[1]!;
      command = switched[2]!;
    }
    if (mode !== 'math mode' && mode !== 'display math mode') continue;
    entries++;
    const name = /^\\(?:[A-Za-z@]+|[^A-Za-z@\s])/.exec(command);
    if (name) names.add(name[0]);
  }
  return { names, entries };
}

const equationPara = (label: string, latex: string): J =>
  para(`${label} `, {}, [
    { type: 'equation', attrs: { latex } },
    { type: 'text', text: '.' },
  ]);

describe('SEC-034 criterion 6: the batch of the fuzz target', () => {
  it('holds the extremes and many accepted equations, and the corpus is refused', () => {
    const batch = accepted();
    for (const s of EXTREMES) expect(batch).toContain(s);
    expect(batch.length).toBeGreaterThanOrEqual(150);
    // The batch is not only single symbols: nested forms and environments are in it.
    expect(batch.filter((s) => s.includes('\\frac{')).length).toBeGreaterThan(10);
    expect(batch.some((s) => s.includes('\\begin{pmatrix}'))).toBe(true);
    for (const s of REFUSED) expect(mathGate(s, false).ok, s).toBe(false);
  });
});

describe.skipIf(!ready)(
  'SEC-034 criterion 6: every accepted equation compiles and is clean',
  () => {
    it('compiles the accepted batch inside the job limits with a clean trace, and replaces the refused corpus', async () => {
      const batch = accepted();
      const body: J[] = [
        ...batch.map((s, i) => equationPara(`A${i}`, s)),
        ...REFUSED.map((s, i) => equationPara(`REFUSED${i}`, s)),
      ];
      const fuzz = await compileTraced('sec-034-gate-fuzz', body);
      const c = fuzz.compiled;

      // The converter: nothing of the accepted batch is refused; every corpus item is.
      const refused = c.bundle.diagnostics.filter((d) => d.code === 'math_refused');
      expect(refused).toHaveLength(REFUSED.length);
      for (const marker of fuzz.main.match(/SEC[A-Z]+/g) ?? [])
        expect(marker, 'text of a refused equation in main.tex').toBe('');

      // The compile, inside the job limits.
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${firstError(c.compile.log)}`);
      expect(c.compile.timedOut).toBe(false);
      expect(c.compile.outputOverflow).toBe(false);
      expect(c.compile.wallMs / 1000).toBeLessThan(JOB_SECONDS);

      // The placeholder is visible, once for each refused equation.
      const text = pdfText(c.compile.pdf);
      if (text === null) throw new Error('pdftotext is not installed or failed');
      expect(text.match(/\[equation\]/g) ?? []).toHaveLength(REFUSED.length);

      // The trace: what the batch adds to the math-mode commands of a baseline.
      const baseline = await compileTraced(
        'sec-034-gate-baseline',
        batch.map((_, i) => equationPara(`A${i}`, 'x')),
      );
      if (!baseline.compiled.compile.ok) throw new Error('the baseline compile failed');
      const base = mathModeCommands(baseline.compiled.compile.log);
      const seen = mathModeCommands(c.compile.log);
      // The trace is on and reaches math mode in both compiles.
      expect(base.entries).toBeGreaterThanOrEqual(batch.length);
      expect(seen.entries).toBeGreaterThan(base.entries);
      const added = [...seen.names].filter((n) => !base.names.has(n)).sort();
      expect(added.length).toBeGreaterThan(0);
      console.info(
        `SEC-034 gate fuzz: ${batch.length} accepted equations, ${Math.round(c.compile.wallMs)} ms, ` +
          `${seen.entries} math-mode trace entries, added commands: ${added.join(' ')}`,
      );
      expect(added.filter((n) => FORBIDDEN_IN_MATH.includes(n))).toEqual([]);
      expect(added.filter((n) => !EXPECTED_ADDED.has(n))).toEqual([]);
    }, 900_000);
  },
);
