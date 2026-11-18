/**
 * Regression fixtures of the math gate (EXP-053 criterion 5; Node.js only).
 *
 * The fuzzer of `src/math/gate.fuzz.test.ts` checks a set of named properties. When one fails,
 * `fuzzAndStore` writes the shrunk input to `test/math-gate-regressions.json` before it reports the
 * failure. The file is read back by `src/math/gate.regressions.test.ts`, which replays every stored
 * input against its property in every run, and by the fuzzer, which gives the stored inputs to its
 * property as `examples`, so that they run before the random cases. A fixture stays in the file
 * after the gate is fixed: it is the regression test.
 */
import fc from 'fast-check';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOW_LIST } from '../src/math/allow-list.ts';
import { mathGate, scanMath } from '../src/math/gate.ts';
import { katexRejects } from '../src/math/katex.ts';

export const REGRESSIONS_FILE = fileURLToPath(
  new URL('./math-gate-regressions.json', import.meta.url),
);

export type PropertyName = 'bounded-decision' | 'allow-listed-words' | 'katex-accepts';

export interface Regression {
  /** The property that failed. */
  property: PropertyName;
  latex: string;
  display: boolean;
  /** The message of the failure, as the fuzzer first saw it. */
  message: string;
}

/** A control word in a string of TeX: a backslash and its letters. */
const CONTROL_WORD = /\\([A-Za-z]+)/g;

/** What each property asserts about one input. A check throws when the property does not hold. */
export const CHECKS: Record<PropertyName, (latex: string, display: boolean) => void> = {
  // Criterion 1: the gate never throws and decides within a bound (a guard against a hang).
  'bounded-decision': (latex, display) => {
    const started = performance.now();
    const r = mathGate(latex, display);
    const elapsed = performance.now() - started;
    if (typeof r.ok !== 'boolean') throw new Error('the gate gave no verdict');
    if (elapsed >= 2000) throw new Error(`the gate took ${elapsed.toFixed(0)} ms`);
  },
  // Criterion 2, lexical half: every control word of an accepted value is on the allow-list.
  'allow-listed-words': (latex) => {
    if (!scanMath(latex).ok) return;
    for (const m of latex.matchAll(CONTROL_WORD)) {
      const name = m[1]!;
      if (name === 'begin' || name === 'end') continue;
      if (!Object.hasOwn(ALLOW_LIST.commands, name))
        throw new Error(`the accepted value uses \\${name}, which is not on the allow-list`);
    }
  },
  // Criterion 3: everything the gate accepts is accepted by KaTeX in strict mode.
  'katex-accepts': (latex, display) => {
    if (!mathGate(latex, display).ok) return;
    const why = katexRejects(latex, display);
    if (why !== null) throw new Error(`the gate accepts a value that KaTeX refuses: ${why}`);
  },
};

export const PROPERTIES = Object.keys(CHECKS) as PropertyName[];

const NOTE =
  'Inputs on which a fuzz property of the math gate once failed (EXP-053 criterion 5). Written by test/gate-regressions.ts when a run fails; replayed by src/math/gate.regressions.test.ts. Do not remove a fixture when the gate is fixed.';

export function loadRegressions(file = REGRESSIONS_FILE): Regression[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { fixtures?: Regression[] };
  return parsed.fixtures ?? [];
}

/** Adds a fixture unless the same input is stored for the same property. True when it was added. */
export function storeRegression(r: Regression, file = REGRESSIONS_FILE): boolean {
  const all = loadRegressions(file);
  if (all.some((f) => f.property === r.property && f.latex === r.latex && f.display === r.display))
    return false;
  all.push(r);
  writeFileSync(file, `${JSON.stringify({ '//': NOTE, fixtures: all }, null, 2)}\n`, 'utf8');
  return true;
}

/**
 * Runs a property over generated inputs, with the seeds and the stored fixtures first. On failure
 * the shrunk counterexample is stored as a fixture (in `file`), and the call throws.
 */
export function fuzzAndStore(
  property: PropertyName,
  arbitrary: fc.Arbitrary<string>,
  seeds: readonly string[],
  options: {
    numRuns?: number;
    file?: string;
    check?: (latex: string, display: boolean) => void;
  } = {},
): void {
  const file = options.file ?? REGRESSIONS_FILE;
  const check = options.check ?? CHECKS[property];
  const examples: [string, boolean][] = [
    ...seeds.flatMap((s): [string, boolean][] => [
      [s, false],
      [s, true],
    ]),
    ...loadRegressions(file)
      .filter((f) => f.property === property)
      .map((f): [string, boolean] => [f.latex, f.display]),
  ];
  const details = fc.check(
    fc.property(arbitrary, fc.boolean(), (latex, display) => {
      check(latex, display);
    }),
    { numRuns: options.numRuns ?? 400, examples },
  );
  if (!details.failed) return;
  const [latex, display] = details.counterexample as [string, boolean];
  const message = String(
    (details.errorInstance as Error | null)?.message ?? details.error ?? 'unknown',
  );
  const added = storeRegression({ property, latex, display, message }, file);
  throw new Error(
    `math gate property ${property} failed on ${JSON.stringify(latex)} (display ${String(display)}): ${message}. ${added ? 'Stored in' : 'Already stored in'} ${file}.`,
  );
}
