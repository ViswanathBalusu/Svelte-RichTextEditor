/**
 * EXP-053 criterion 2, the token-stream half (lane V-EXP-049-064, Podman through the export worker
 * sandbox). For values the gate accepts, the TeX engine runs with `\tracingcommands` on around the
 * value, and the control sequences it executes for the value are read from the log.
 *
 * What this test checks, and what it does not (recorded in the story Notes):
 * - The trace of the value is compared with the trace of an empty equation in the same document, so
 *   the class's wrapper and the kernel's own work for every equation are not counted.
 * - The strict reading of criterion 2 ("no control sequence outside the allow-list") is NOT met: a
 *   value with `\frac` also runs kernel and expl3 internals (tagging socket, `\msg`, `\tl`, `\ifx` and
 *   similar), which are not on the allow-list and cannot be listed one by one. The test reports how
 *   many such words each value adds (`observed-words.txt`, `kernel-words` in the log) and does not
 *   count them as failures.
 * - What the test does enforce: no I/O, shell or engine primitive (`DANGEROUS`) appears in a value's
 *   trace that is not in the baseline. A value that reaches `\input`, `\write`, `\openout`, `\read`,
 *   `\directlua`, `\catcode` and the like would fail here.
 * - The painting half of criterion 2 is not checked here. The class clips display equations to their
 *   box (EXP-052 criterion 5, `exp-052-clip.compile.test.ts`); inline equations are not clipped.
 *
 * Skipped when the sandbox cannot run here.
 */
import fc from 'fast-check';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.ts';
import { ALLOW_LIST } from '../src/math/allow-list.ts';
import { mathGate } from '../src/math/gate.ts';
import { classFiles, compileBundle, imageFonts, sandboxReady } from './harness.ts';
import { DANGEROUS } from './trace-denylist.ts';
import { doc, nid, para } from './docs.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const PLACEHOLDER = 'QQQ';
const BEGIN = '<<TRACE-BEGIN>>';
const END = '<<TRACE-END>>';
const OUT = join(tmpdir(), 'docedit-v-exp-049-064-053');

/** Primitives with I/O, shell, catcode, or engine-level effects (decision 212, ADR 0320): `trace-denylist.ts`. */
export { DANGEROUS };

/** Control words of a TeX log segment (a backslash and its letters or `@`). */
const CONTROL_WORD = /\\([A-Za-z@]+)/g;

/** The control sequences of a log between the two markers, or null if the markers are missing. */
export function tracedWords(log: string): Set<string> | null {
  const start = log.indexOf(BEGIN);
  if (start < 0) return null;
  const end = log.indexOf(END, start + BEGIN.length);
  if (end < 0) return null;
  const out = new Set<string>();
  for (const m of log.slice(start + BEGIN.length, end).matchAll(CONTROL_WORD)) out.add(m[1]!);
  return out;
}

/** The traced words that the value added over the baseline, and of those, the dangerous ones. */
export function added(
  words: ReadonlySet<string>,
  baseline: ReadonlySet<string>,
): { dangerous: string[]; other: string[] } {
  const dangerous: string[] = [];
  const other: string[] = [];
  for (const w of words) {
    if (baseline.has(w)) continue;
    if (DANGEROUS.has(w)) dangerous.push(w);
    else if (!Object.hasOwn(ALLOW_LIST.commands, w)) other.push(w);
  }
  return { dangerous: dangerous.sort(), other: other.sort() };
}

/** Values the gate accepts: hand-written ones, and a fixed-seed sample of generated ones. */
const HAND = [
  'x^2+y^2=z^2',
  '\\frac{a}{b}',
  '\\sqrt{2}',
  '\\alpha\\beta\\gamma',
  '\\sum_{i=1}^{n} i',
  '\\int_0^1 x\\,dx',
  '\\left(\\frac{1}{2}\\right)',
  '\\hat{x}\\cdot\\vec{y}',
  '\\begin{aligned} a&=b \\\\ c&=d \\end{aligned}',
  '\\begin{cases} 1 & x>0 \\\\ 0 & x\\le 0 \\end{cases}',
  '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
];
const GENERATED_FRAGMENTS = [
  'x',
  'y',
  '1',
  '2',
  '^',
  '_',
  '{',
  '}',
  '+',
  '\\frac',
  '\\alpha',
  '\\sum',
  '\\,',
  '=',
];
const generatedArb = fc
  .array(fc.constantFrom(...GENERATED_FRAGMENTS), { minLength: 1, maxLength: 10 })
  .map((parts) => parts.join(''));
const generated = fc
  .sample(generatedArb, { seed: 20261114, numRuns: 400 })
  .filter((v) => mathGate(v, true).ok)
  .slice(0, 4);

/** The document: one display equation with the placeholder, between two paragraphs. */
async function compiledWith(replacement: string, label: string) {
  const body = [
    para('Before the equation.', {}, []),
    { type: 'equation_block', attrs: { id: nid('env'), latex: PLACEHOLDER } },
    para('After the equation.', {}, []),
  ];
  const bundle = await convert(doc(body), {
    fonts: await imageFonts(),
    classFiles: classFiles(),
    profile: 'preview',
    title: 'exp-053-trace',
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
  } as never);
  const hits = Object.entries(bundle.files).filter(([, text]) => text.includes(PLACEHOLDER));
  expect(hits.map(([name]) => name)).toEqual(['main.tex']);
  bundle.files['main.tex'] = bundle.files['main.tex']!.split(PLACEHOLDER).join(replacement);
  const out = await compileBundle(bundle, { maxPasses: 1, minPasses: 1 });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${label}.log`), out.compile.log);
  return out;
}

/** Turns tracing on around the value and marks the segment in the log. */
function traced(value: string): string {
  return `\\message{${BEGIN}}\\tracingonline=0 \\tracingcommands=3 \\tracingmacros=2 ${value}\\tracingcommands=0 \\tracingmacros=0 \\message{${END}}`;
}

describe('EXP-053 criterion 2 (token-stream half): accepted values trace no I/O or engine primitive', () => {
  it('accepts every hand-written value and at least one generated value', () => {
    for (const v of HAND) expect(mathGate(v, true).ok, v).toBe(true);
    expect(generated.length).toBeGreaterThan(0);
  });

  it('a dangerous primitive in a trace is reported (the check is not vacuous)', () => {
    const words = tracedWords(`x${BEGIN}\\frac \\input \\write18 \\alpha \\kern${END}y`)!;
    expect(added(words, new Set())).toEqual({
      dangerous: ['input', 'write'],
      other: ['frac', 'kern'].filter((w) => !Object.hasOwn(ALLOW_LIST.commands, w)),
    });
  });

  it.skipIf(!ready)(
    'compiles each accepted value and finds no dangerous primitive in its trace',
    async () => {
      const baseline = await compiledWith(traced(''), 'baseline');
      expect(baseline.compile.ok).toBe(true);
      const base = tracedWords(baseline.compile.log);
      expect(base).not.toBeNull();

      const kernel = new Map<string, number>();
      const report: string[] = [];
      for (const [i, value] of [...HAND, ...generated].entries()) {
        const c = await compiledWith(traced(value), `value-${i}`);
        expect(c.compile.ok, value).toBe(true);
        const words = tracedWords(c.compile.log);
        expect(words, value).not.toBeNull();
        const r = added(words!, base!);
        for (const w of r.other) kernel.set(w, (kernel.get(w) ?? 0) + 1);
        report.push(
          `${value}\n  dangerous: ${r.dangerous.join(', ') || 'none'}\n  other (not on allow-list): ${r.other.length}`,
        );
        expect(r.dangerous, `${value} traced ${r.dangerous.join(', ')}`).toEqual([]);
      }
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, 'report.txt'), report.join('\n') + '\n');
      writeFileSync(join(OUT, 'other-words.txt'), [...kernel.keys()].sort().join('\n') + '\n');
    },
    1_800_000,
  );
});
