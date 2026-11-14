/**
 * EXP-046 criterion 2 (lane U-EXP-033-048, round 6; Node.js only, sandbox): random and mutated strings
 * for the `pdfString` and `url` emitters are compiled, and a token trace of the compile holds no control
 * sequence that a baseline compile lacks.
 *
 * Method. The body holds figures without a picture (their alternative text goes through `pdfString`)
 * and links (their targets go through `url`). Each document is converted, and `\tracingmacros2`,
 * `\tracingcommands2` and `\tracingonline1` are switched on right after `\begin{document}` (on the same
 * line, so the line map of the bundle is unchanged). The compile log is the trace.
 *
 * The trace is at level 1 of `\tracingcommands` (unexpandable commands, such as `\input`, `\write`,
 * `\immediate` and `\def`, which are the ones an injected string could run). Level 2 with
 * `\tracingmacros2` writes about 200 MB of log for this batch, because hyperref purifies every link
 * target, so the expandable macros the emitters write are not in the trace. Level 1 is therefore a
 * narrower check than "every control sequence"; the criterion's wording is only partly met by it.
 *
 * The baseline is a compile of the same structure whose strings hold every printable ASCII character, in
 * chunks of 40, so every escape the emitters can write is in it. A control sequence of the random compile
 * that the baseline does not have is a control sequence that the emitter did not write, so the test fails
 * on it. A positive control checks that the trace is on (the baseline holds `\textbackslash`).
 *
 * Not covered (so EXP-046 criterion 2 stays unticked): the `kvValue` (document title), `dimen`, `color`,
 * `enumLookup` and `generatedId` emitters, which need their own documents in this batch.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.ts';
import { doc, nid, type J } from '../test/docs.ts';
import {
  classFiles,
  compileBundle,
  firstError,
  imageFonts,
  keep,
  sandboxReady,
} from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

const OPTIONS = {
  profile: 'preview',
  instant: INSTANT,
  timeZone: 'Europe/London',
  suggestions: 'accept',
} as const;

/** Printable ASCII and the space: the alphabet of the random strings (as in `emit.compile.fuzz.test.ts`). */
const ALPHABET = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  ...'\\{}$&#_%^~[],=.:;!?()/@*+<>-\'"`|',
  ' ',
];

/** Known attacks: each one reaches the batch, so each one is traced. */
const SEEDS: readonly string[] = [
  '\\input{/etc/passwd}',
  '\\write18{id}',
  '^^5c^^5cwrite18',
  '{',
  '}',
  ']',
  'a,b=c]',
  '%comment',
  '#1#2',
  '\\end{document}',
  '\\textbackslash{}',
  '\\\\',
];

const RANDOM_RUNS = 30;

/** A string the batch can carry: no leading, trailing or repeated space, at most 40 characters. */
function fits(s: string): boolean {
  return (
    s.length > 0 &&
    s.length <= 40 &&
    !/^ | $| {2}/.test(s) &&
    [...s].every((c) => ALPHABET.includes(c))
  );
}

/** Random strings over the alphabet, and seeds with one character inserted (mutations). */
const candidate: fc.Arbitrary<string> = fc.oneof(
  fc
    .array(fc.constantFrom(...ALPHABET), { minLength: 1, maxLength: 40, size: 'large' })
    .map((a) => a.join('')),
  fc
    .tuple(fc.constantFrom(...SEEDS), fc.nat(40), fc.constantFrom(...ALPHABET))
    .map(([s, at, c]) => {
      const i = at % (s.length + 1);
      return s.slice(0, i) + c + s.slice(i);
    }),
);

/** The fixed-seed batch: the seeds, then random and mutated strings, without duplicates. */
function batch(): string[] {
  const random = fc.sample(candidate.filter(fits), { seed: 46, numRuns: RANDOM_RUNS });
  return [...new Set([...SEEDS, ...random])];
}

/** The baseline: every printable ASCII character, in chunks of at most 40 that have no outer space. */
function baselineChunks(): string[] {
  const all = ALPHABET.join('');
  const out: string[] = [];
  for (let i = 0; i < all.length; i += 40) {
    const chunk = all.slice(i, i + 40).trim();
    if (chunk.length > 0) out.push(chunk);
  }
  return out;
}

function figures(alts: readonly string[]): J[] {
  return alts.map((alt) => ({
    type: 'figure',
    attrs: { id: nid('f'), width: 1440, height: 1440, alt },
  }));
}

function links(hrefs: readonly string[]): J[] {
  return hrefs.map((href) => ({
    type: 'paragraph',
    attrs: { id: nid('p') },
    content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href } }] }],
  }));
}

/** Converts a body, switches the token trace on after `\begin{document}`, and compiles it. */
async function compileTraced(body: J[], inject = '') {
  const bundle = await convert(doc(body), {
    fonts: await imageFonts(),
    classFiles: classFiles(),
    ...OPTIONS,
    title: 'emit-trace',
  } as never);
  const main = bundle.files['main.tex'];
  if (typeof main !== 'string' || !main.includes('\\begin{document}'))
    throw new Error('main.tex has no \\begin{document}');
  bundle.files['main.tex'] = main.replace(
    '\\begin{document}',
    `\\begin{document}\\tracingonline1 \\tracingcommands1 ${inject}`,
  );
  return compileBundle(bundle);
}

/**
 * The control sequences in a compile log. TeX wraps a log line after 79 characters, so a line of that
 * length is joined to the next one before the names are read, and a name cut by the wrap is not split.
 */
function controlNames(log: string): Set<string> {
  let joined = '';
  for (const line of log.split('\n')) joined += line.length === 79 ? line : `${line}\n`;
  const names = new Set<string>();
  for (const m of joined.matchAll(/\\(?:[A-Za-z@]+|[^A-Za-z@\s])/g)) names.add(m[0]);
  return names;
}

describe.skipIf(!ready)(
  'EXP-046 criterion 2: pdfString and url strings leave no control sequence the emitter did not write',
  () => {
    it('the token trace of the random batch has no control sequence that the baseline trace lacks', async () => {
      const chunks = baselineChunks();
      const baseline = await compileTraced([
        ...figures(chunks),
        ...links(chunks.map((c) => `https://example.org/${c}`)),
      ]);
      const strings = batch();
      const random = await compileTraced([
        ...figures(strings),
        ...links(strings.map((s) => `https://example.org/${s}`)),
      ]);

      if (!baseline.compile.ok || !baseline.compile.pdf)
        throw new Error(`the baseline compile failed:\n${baseline.compile.log.slice(-1500)}`);
      if (!random.compile.ok || !random.compile.pdf)
        throw new Error(
          `the random compile failed (${keep('exp-046-trace-random', random)}):\n${firstError(random.compile.log)}`,
        );

      const allowed = controlNames(baseline.compile.log);
      // Positive control: the trace is on and writes unexpandable commands (level 1 does not show the
      // expandable escape macros such as `\textbackslash`), so the baseline's set is not empty.
      expect(allowed.size).toBeGreaterThan(0);

      const extra = [...controlNames(random.compile.log)].filter((n) => !allowed.has(n));
      expect(extra).toEqual([]);
    }, 900_000);

    it('negative control: an unexpandable command the emitters did not write is reported', async () => {
      const chunks = baselineChunks();
      const baseline = await compileTraced([
        ...figures(chunks),
        ...links(chunks.map((c) => `https://example.org/${c}`)),
      ]);
      // A raw `\special`, as an unescaped string would leave it, is run once in the body.
      const leaked = await compileTraced(
        [...figures(chunks), ...links(chunks.map((c) => `https://example.org/${c}`))],
        '\\special{probe}',
      );
      if (!baseline.compile.ok || !baseline.compile.pdf)
        throw new Error(`the baseline compile failed:\n${baseline.compile.log.slice(-1500)}`);
      if (!leaked.compile.ok || !leaked.compile.pdf)
        throw new Error(
          `the leaked compile failed (${keep('exp-046-trace-leak', leaked)}):\n${firstError(leaked.compile.log)}`,
        );
      const extra = [...controlNames(leaked.compile.log)].filter(
        (n) => !controlNames(baseline.compile.log).has(n),
      );
      expect(extra).toContain('\\special');
    }, 900_000);
  },
);
