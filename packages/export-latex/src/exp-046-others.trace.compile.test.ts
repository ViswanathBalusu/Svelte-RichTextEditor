/**
 * EXP-046 criterion 2, the other emitters (lane U-EXP-033-048, round 8; Node.js only, sandbox): random and
 * mutated strings for the `kvValue` (document title), `dimen` (paragraph indents, clamped), `color` (cell
 * shading) and `enumLookup` (paragraph alignment) emitters are compiled, and a token trace of the compile
 * holds no control sequence that a baseline compile lacks.
 *
 * Method. The title goes through `kvValue` in the preamble, so the trace is switched on right after the
 * `\documentclass` line (not after `\begin{document}`, which would miss the preamble). The body holds
 * paragraphs with an alignment and an indent, and cells with a shading. The baseline uses every known
 * alignment, valid colours, and an indent of 0 and 720 twips, so every macro the emitters can write is in it.
 * The random compile uses strings from the same alphabet as `exp-046-trace.compile.test.ts` (and the seeds)
 * for the title, alignment and shading, and random integers for the indent.
 *
 * `generatedId` takes a counter, not a string, so its test compiles a document of a few blocks and one of
 * many blocks and tables (the block numbers and anchors differ) and compares the traces the same way.
 * Each comparison also names the denylist of dangerous primitives (`test/trace-denylist.ts`; decision 212
 * of docs/owner-decisions-2026-11-15.md says "nothing unexpected" is a denylist, ADR 0320) and fails on a
 * word of it that the baseline lacks.
 *
 * Limit, as in `exp-046-trace.compile.test.ts`: the trace is at level 1 of `\tracingcommands`, so
 * expandable macros are not traced. A positive control checks that the trace is on, and a negative
 * control checks that a `\special` in the body is reported (as a denylist word).
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.ts';
import { doc, nid, para, type J } from '../test/docs.ts';
import {
  classFiles,
  compileBundle,
  firstError,
  imageFonts,
  keep,
  sandboxReady,
} from '../test/harness.ts';
import { dangerousIn } from '../test/trace-denylist.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

const OPTIONS = {
  profile: 'preview',
  instant: INSTANT,
  timeZone: 'Europe/London',
  suggestions: 'accept',
} as const;

/** Printable ASCII and the space: the alphabet of the random strings (as in `exp-046-trace.compile.test.ts`). */
const ALPHABET = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  ...'\\{}$&#_%^~[],=.:;!?()/@*+<>-\'"`|',
  ' ',
];

/** Known attacks and known values: each one reaches the batch, so each one is traced. */
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
  'center',
  'justify',
  '#0000FF',
  '#zzzzzz',
];

/** Alignments the table knows, and colours that are six hexadecimal digits: the baseline uses all of them. */
const KNOWN_ALIGN = ['justify', 'distribute', 'start', 'center', 'end'];
const KNOWN_COLOUR = ['#0000FF', '#FFFF00', '#00C000', '#123456', '#ABCDEF'];

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

/**
 * The indents of the random compile: random integers within the text block (0 to 4000 twentieths of a point).
 * Values beyond the clamp are not used here: an indent past the margin gives an overfull box, and the log of
 * an overfull box prints a font identifier (`\TU/...`) that is not a control sequence. The clamp is tested
 * in `emit.test.ts`.
 */
function indents(n: number): number[] {
  return fc.sample(fc.integer({ min: 0, max: 4000 }), { seed: 46, numRuns: n });
}

function paragraphs(texts: readonly string[], aligns: readonly string[]): J[] {
  return texts.map((text, i) => para(text, { align: aligns[i % aligns.length] }));
}

function shadedTable(fills: readonly string[]): J {
  return {
    type: 'table',
    attrs: { id: nid('t'), grid: [2880] },
    content: fills.map((fill, i) => ({
      type: 'table_row',
      attrs: { id: nid('r') },
      content: [
        {
          type: 'table_cell',
          attrs: { id: nid('c'), shading: { fill } },
          content: [para(`CELL${i}`)],
        },
      ],
    })),
  };
}

/** Converts a body with the title, switches the token trace on after the class line, and compiles it. */
async function compileTraced(title: string, body: J[], inject = '') {
  const bundle = await convert(doc(body), {
    fonts: await imageFonts(),
    classFiles: classFiles(),
    ...OPTIONS,
    title,
  } as never);
  const main = bundle.files['main.tex'];
  if (typeof main !== 'string' || !main.includes('\\begin{document}'))
    throw new Error('main.tex has no \\begin{document}');
  const withClass = main.replace(
    /\\documentclass\[[^\]]*\]\{docedit\}/,
    (m) => `${m}\\tracingonline1 \\tracingcommands1 `,
  );
  if (withClass === main) throw new Error('main.tex has no docedit class line');
  bundle.files['main.tex'] = withClass.replace('\\begin{document}', `\\begin{document}${inject}`);
  return compileBundle(bundle);
}

/** The baseline body: every known alignment, every valid colour, and the indents 0 and 720 twips. */
function baselineBody(): { title: string; body: J[] } {
  const texts = KNOWN_ALIGN.map((_, i) => `KNOWN${i}`);
  const body = [
    ...paragraphs(texts, KNOWN_ALIGN),
    para('INDENT0', { indentLeft: 0 }),
    para('INDENT720', { indentLeft: 720 }),
    shadedTable(KNOWN_COLOUR),
  ];
  return { title: ALPHABET.join(''), body };
}

/** The random body: each string as an alignment and as a cell shading, and each integer as an indent. */
function randomBody(strings: readonly string[]): { title: string; body: J[] } {
  const ints = indents(strings.length);
  const body: J[] = [
    ...paragraphs(
      strings.map((_, i) => `R${i}`),
      strings,
    ),
    ...ints.map((n, i) => para(`I${i}`, { indentLeft: n })),
    shadedTable(strings),
  ];
  return { title: strings.join(' ').slice(0, 400), body };
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
  'EXP-046 criterion 2, other emitters: kvValue, dimen, color and enumLookup leave no control sequence the emitter did not write',
  () => {
    it('the token trace of the random batch has no control sequence that the baseline trace lacks', async () => {
      const base = baselineBody();
      const baseline = await compileTraced(base.title, base.body);
      const strings = batch();
      const rnd = randomBody(strings);
      const random = await compileTraced(rnd.title, rnd.body);

      if (!baseline.compile.ok || !baseline.compile.pdf)
        throw new Error(`the baseline compile failed:\n${baseline.compile.log.slice(-1500)}`);
      if (!random.compile.ok || !random.compile.pdf)
        throw new Error(
          `the random compile failed (${keep('exp-046-others-random', random)}):\n${firstError(random.compile.log)}`,
        );

      const allowed = controlNames(baseline.compile.log);
      // Positive control: the trace is on and writes unexpandable commands in the baseline.
      expect(allowed.size).toBeGreaterThan(0);

      const extra = [...controlNames(random.compile.log)].filter((n) => !allowed.has(n));
      if (extra.length > 0) {
        // Show where each extra name is in the log, and keep the log, so the cause can be read.
        const where = extra.map((n) => {
          const at = random.compile.log.indexOf(n);
          return `${n} at ${at}: ${JSON.stringify(random.compile.log.slice(Math.max(0, at - 200), at + 80))}`;
        });
        throw new Error(
          `extra control sequences (${keep('exp-046-others-extra', random)}):\n${where.join('\n')}`,
        );
      }
      expect(extra).toEqual([]);
      expect(dangerousIn(extra)).toEqual([]);
    }, 900_000);

    it('generatedId: a document of many blocks and tables has no control sequence that a small one lacks', async () => {
      const small = await compileTraced('ids', [
        para('ONE'),
        para('TWO'),
        shadedTable(['#0000FF']),
      ]);
      const many: J[] = [];
      for (let i = 0; i < 120; i++) many.push(para(`P${i}`));
      for (let i = 0; i < 6; i++) many.push(shadedTable(KNOWN_COLOUR));
      const large = await compileTraced('ids', many);
      if (!small.compile.ok || !small.compile.pdf)
        throw new Error(`the small compile failed:\n${small.compile.log.slice(-1500)}`);
      if (!large.compile.ok || !large.compile.pdf)
        throw new Error(
          `the large compile failed (${keep('exp-046-ids-large', large)}):\n${firstError(large.compile.log)}`,
        );
      const allowed = controlNames(small.compile.log);
      expect(allowed.size).toBeGreaterThan(0);
      const extra = [...controlNames(large.compile.log)].filter((n) => !allowed.has(n));
      expect(extra).toEqual([]);
      expect(dangerousIn(extra)).toEqual([]);
    }, 900_000);

    it('negative control: an unexpandable command the emitters did not write is reported', async () => {
      const base = baselineBody();
      const baseline = await compileTraced(base.title, base.body);
      // A raw `\special`, as an unescaped string would leave it, is run once in the body.
      const leaked = await compileTraced(base.title, base.body, '\\special{probe}');
      if (!baseline.compile.ok || !baseline.compile.pdf)
        throw new Error(`the baseline compile failed:\n${baseline.compile.log.slice(-1500)}`);
      if (!leaked.compile.ok || !leaked.compile.pdf)
        throw new Error(
          `the leaked compile failed (${keep('exp-046-others-leak', leaked)}):\n${firstError(leaked.compile.log)}`,
        );
      const extra = [...controlNames(leaked.compile.log)].filter(
        (n) => !controlNames(baseline.compile.log).has(n),
      );
      expect(extra).toContain('\\special');
      expect(dangerousIn(extra)).toContain('\\special');
    }, 900_000);
  },
);
