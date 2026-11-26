/**
 * SEC-033 criterion 1, the token-trace half for every emitter other than `text` (lane w8; Node.js
 * only, real sandbox): the hostile strings the criterion names are fed to `pdfString` (figure
 * alternative text), `url` (link targets), `kvValue` (document title), `enumLookup` (paragraph
 * alignment), `color` (cell shading) and `dimen` (indents, with integers past the clamp), and the job
 * compiles with no control sequence in the token trace that a baseline compile lacks. `generatedId`
 * takes a counter and is traced in `exp-046-others.trace.compile.test.ts`.
 *
 * The hostile strings are the ones of the criterion that `exp-046-*` do not carry: `\directlua`,
 * `\immediate\write18`, `\csname`, a category-code change, `^^` notation for a backslash, a `[` after
 * a line break, bidirectional overrides and isolates, control characters, and very long input (3,000
 * characters of text, of backslashes and of open braces). They run beside the baseline of every
 * printable ASCII character that the exp-046 files use.
 *
 * Reading of "the token trace" (owner decision 65 in docs/owner-decisions-2026-11-15.md: the
 * level-1 trace is enough): `\tracingcommands1`, the unexpandable commands TeX executes. Expandable
 * macros are not in it. "Contains no control sequence the emitter did not write" is read as in
 * EXP-046: none that the baseline trace, which holds every escape the emitters can write, lacks, and
 * none of the denylist of dangerous primitives (ADR 0320).
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
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

const OPTIONS = {
  profile: 'preview',
  instant: '2026-11-06T10:00:00.000Z',
  timeZone: 'Europe/London',
  suggestions: 'accept',
} as const;

const ALPHABET = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  ...'\\{}$&#_%^~[],=.:;!?()/@*+<>-\'"`|',
  ' ',
];

/** What the exp-046 batches do not carry: the rest of the criterion's list (the very long input is in `LONG`). */
const HOSTILE: readonly string[] = [
  '\\directlua{os.execute("id")}',
  '\\immediate\\write18{id}',
  '\\csname relax\\endcsname',
  '\\catcode`\\{=12 \\input{/etc/passwd}',
  '^^5cdirectlua{x}^^5c^^5cwrite18',
  'a\n[b]',
  'a\r\n[b,c=d]',
  '\u202Eevil\u202C and \u2066x\u2069 and \u200Fy\u200E',
  'ctl\u0001\u0007\u001b\u007f\u0085end',
];

/** Very long input: one string of 3,000 characters (text, backslashes and open braces), in one slot at a time. */
const LONG = `${'x'.repeat(1000)}${'\\'.repeat(1000)}${'{'.repeat(1000)}`;

/** The baseline strings: every printable ASCII character, in chunks of at most 40 with no outer space. */
function baselineChunks(): string[] {
  const all = ALPHABET.join('');
  const out: string[] = [];
  for (let i = 0; i < all.length; i += 40) {
    const chunk = all.slice(i, i + 40).trim();
    if (chunk.length > 0) out.push(chunk);
  }
  return out;
}

const KNOWN_ALIGN = ['justify', 'distribute', 'start', 'center', 'end'];
const KNOWN_COLOUR = ['#0000FF', '#FFFF00', '#00C000', '#123456', '#ABCDEF'];

const figures = (alts: readonly string[]): J[] =>
  alts.map((alt) => ({
    type: 'figure',
    attrs: { id: nid('f'), width: 1440, height: 1440, alt },
  }));

const links = (hrefs: readonly string[]): J[] =>
  hrefs.map((href) => ({
    type: 'paragraph',
    attrs: { id: nid('p') },
    content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href } }] }],
  }));

const aligned = (values: readonly string[]): J[] =>
  values.map((v, i) => para(`A${i}`, { align: v }));

const indented = (values: readonly number[]): J[] =>
  values.map((n, i) => para(`I${i}`, { indentLeft: n }));

const shaded = (fills: readonly string[]): J => ({
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
});

async function compileTraced(title: string, body: J[]) {
  const bundle = await convert(doc(body), {
    fonts: await imageFonts(),
    classFiles: classFiles(),
    ...OPTIONS,
    title,
  } as never);
  const main = bundle.files['main.tex'];
  if (typeof main !== 'string' || !main.includes('\\begin{document}'))
    throw new Error('main.tex has no \\begin{document}');
  // The trace is on from the class line, so the title in the preamble is traced too.
  const withClass = main.replace(
    /\\documentclass\[[^\]]*\]\{docedit\}/,
    (m) => `${m}\\tracingonline1 \\tracingcommands1 `,
  );
  if (withClass === main) throw new Error('main.tex has no docedit class line');
  bundle.files['main.tex'] = withClass;
  return compileBundle(bundle);
}

function controlNames(log: string): Set<string> {
  let joined = '';
  for (const line of log.split('\n')) joined += line.length === 79 ? line : `${line}\n`;
  const names = new Set<string>();
  // The name of a font in an overfull-box message (`\TU/<hash>.ttf(0)/m/n/...`) is not a control sequence.
  joined = joined.replace(/\\TU\/\S*/g, '');
  for (const m of joined.matchAll(/\\(?:[A-Za-z@]+|[^A-Za-z@\s])/g)) names.add(m[0]);
  return names;
}

describe.skipIf(!ready)(
  'SEC-033 criterion 1: hostile strings in every emitter but `text` leave no control sequence the emitter did not write',
  () => {
    it('the token trace of the hostile batch has no control sequence that the baseline trace lacks', async () => {
      const chunks = baselineChunks();
      const baseline = await compileTraced(ALPHABET.join(''), [
        ...figures(chunks),
        ...links(chunks.map((c) => `https://example.org/${c}`)),
        ...aligned(KNOWN_ALIGN),
        ...indented([0, 720]),
        shaded(KNOWN_COLOUR),
      ]);
      const hostile = await compileTraced(HOSTILE.join(' ').slice(0, 2000), [
        ...figures(HOSTILE),
        ...links(HOSTILE.map((s) => `https://example.org/${s}`)),
        ...aligned(HOSTILE),
        // Past the clamp of `dimen`, negative and not whole numbers among them.
        ...indented([0, 720, 4000, 1_000_000, 2_147_483_647, -5, -1_000_000, 1.5, Number.NaN]),
        shaded(HOSTILE),
      ]);

      if (!baseline.compile.ok || !baseline.compile.pdf)
        throw new Error(`the baseline compile failed:\n${baseline.compile.log.slice(-1500)}`);
      if (!hostile.compile.ok || !hostile.compile.pdf)
        throw new Error(
          `the hostile compile failed (${keep('sec-033-hostile-trace', hostile)}):\n${firstError(hostile.compile.log)}`,
        );

      const allowed = controlNames(baseline.compile.log);
      // Positive control: the trace is on and writes unexpandable commands in the baseline.
      expect(allowed.size).toBeGreaterThan(0);
      const extra = [...controlNames(hostile.compile.log)].filter((n) => !allowed.has(n));
      if (extra.length > 0) {
        const where = extra.map((n) => {
          const at = hostile.compile.log.indexOf(n);
          return `${n} at ${at}: ${JSON.stringify(hostile.compile.log.slice(Math.max(0, at - 200), at + 80))}`;
        });
        throw new Error(
          `extra control sequences (${keep('sec-033-hostile-extra', hostile)}):\n${where.join('\n')}`,
        );
      }
      expect(extra).toEqual([]);
      expect(dangerousIn([...controlNames(hostile.compile.log)])).toEqual(
        dangerousIn([...allowed]),
      );
    }, 900_000);

    // Very long input goes through each emitter on its own, so that a failure names the emitter.
    const SLOTS: ReadonlyArray<[string, (s: string) => { title: string; body: J[] }]> = [
      ['kvValue (title)', (s) => ({ title: s, body: [para('X')] })],
      ['pdfString (figure alternative text)', (s) => ({ title: 't', body: figures([s]) })],
      ['url (link target)', (s) => ({ title: 't', body: links([`https://example.org/${s}`]) })],
      ['enumLookup (alignment)', (s) => ({ title: 't', body: aligned([s]) })],
      ['color (cell shading)', (s) => ({ title: 't', body: [shaded([s])] })],
    ];
    it.each(SLOTS)(
      'a string of 3,000 characters in %s compiles with a clean trace',
      async (_name, make) => {
        const known = await compileTraced('t', [
          ...figures(['known']),
          ...links(['https://example.org/known']),
          ...aligned(KNOWN_ALIGN),
          shaded(KNOWN_COLOUR),
          para('X'),
        ]);
        const one = make(LONG);
        const long = await compileTraced(one.title, one.body);
        if (!known.compile.ok || !known.compile.pdf)
          throw new Error(`the baseline compile failed:
${known.compile.log.slice(-1500)}`);
        if (!long.compile.ok || !long.compile.pdf)
          throw new Error(
            `the long-input compile failed (${keep('sec-033-long', long)}):
${firstError(long.compile.log)}`,
          );
        const allowed = controlNames(known.compile.log);
        expect(allowed.size).toBeGreaterThan(0);
        const extra = [...controlNames(long.compile.log)].filter((n) => !allowed.has(n));
        expect(extra).toEqual([]);
        expect(dangerousIn(extra)).toEqual([]);
      },
      900_000,
    );
  },
);
