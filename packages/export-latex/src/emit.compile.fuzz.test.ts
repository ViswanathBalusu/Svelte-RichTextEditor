/**
 * EXP-046 criterion 1 (Node.js only, sandbox): random and mutated strings for the `text` emitter
 * are typeset, and the text of the compiled PDF equals each input.
 *
 * The strings are generated with fast-check from a seed, and the known attacks of `emit.fuzz.test.ts`
 * are in the batch. All of them go into one document, one paragraph each, so one compile checks
 * them all (a compile takes several seconds). Every seed is compiled; the test fails if one would
 * be left out. The generator draws from printable ASCII and the space: upper- and lower-case
 * letters, digits, every TeX special, hyphen, quotes and the other punctuation. The class loads
 * fonts with `Ligatures=TeXOff`, so `--` and quotes stay as typed; the font's own ligatures (`fi`,
 * `ff`, `fl`, `ffi`, `ffl`) are compared with the PDF text expanded by NFKC, and fixed words that
 * hold them are in the batch. Each string fits on one line, so `pdftotext -raw` returns it as one
 * line. Strings with leading, trailing or repeated spaces are left out, because those are the
 * rules of EXP-025, not of the emitter.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { CORPUS_DIR, storeFixture } from '../test/emitter-corpus.ts';
import { convertAndCompile, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** Known attacks (the same seeds as `emit.fuzz.test.ts`), every one compiled. */
const SEEDS: readonly string[] = [
  '\\input{/etc/passwd}',
  '\\write18{id}',
  '\\immediate\\write18{id}',
  '^^5c^^5cwrite18',
  '{',
  '}',
  '{{}}',
  '}{',
  ']',
  '[',
  'a,b=c]',
  ',x=y',
  '\\DEstr{41}',
  '%comment',
  '#1#2',
  '$$x$$',
  '&',
  '~',
  '\\\\',
  '\\end{document}',
  '\\textbackslash{}',
  '{[}',
  '\\-',
];

/** Words that the font joins into ligatures, so the comparison through NFKC is exercised. */
const LIGATURES: readonly string[] = [
  'office affluent fjord',
  'baffle waffle shuffle',
  'fifty flaming ruffians',
  'fi ff fl ffi ffl',
];

/** Characters the batch draws from: printable ASCII and the space. */
const ALPHABET = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  ...'\\{}$&#_%^~[],=.:;!?()/@*+<>-\'"`|',
  ' ',
];
const SPECIALS = [...'\\{}$&#_%^~[]'];

/** A string the batch can carry: no leading, trailing or repeated space, at most 40 characters. */
function fits(s: string): boolean {
  return (
    s.length > 0 &&
    s.length <= 40 &&
    !/^ | $| {2}/.test(s) &&
    [...s].every((c) => ALPHABET.includes(c))
  );
}

/** Random strings from the alphabet, and seeds with one special character inserted (mutations). */
const candidate: fc.Arbitrary<string> = fc.oneof(
  fc
    .array(fc.constantFrom(...ALPHABET), { minLength: 1, maxLength: 40, size: 'large' })
    .map((a) => a.join('')),
  fc
    .tuple(fc.constantFrom(...SEEDS), fc.nat(40), fc.constantFrom(...SPECIALS))
    .map(([s, at, c]) => {
      const i = at % (s.length + 1);
      return s.slice(0, i) + c + s.slice(i);
    }),
);

const RANDOM_RUNS = 120;

/** The fixed-seed random and mutated strings. */
function random(): string[] {
  return fc.sample(candidate.filter(fits), { seed: 46, numRuns: RANDOM_RUNS });
}

/** The batch: every seed once, the ligature words, then the random and mutated strings. */
function batch(): string[] {
  return [...new Set([...SEEDS, ...LIGATURES, ...random()])];
}

/** The PDF's lines, ligature glyphs expanded (NFKC) and trailing spaces removed. */
function lines(text: string): string[] {
  return text
    .normalize('NFKC')
    .split(/\r?\n|\f/)
    .map((l) => l.replace(/\s+$/, ''));
}

describe('EXP-046 criterion 1: the batch', () => {
  it('holds every known-attack seed, unfiltered, and the alphabet holds lower-case letters', () => {
    expect(SEEDS.filter((s) => !fits(s))).toEqual([]);
    const strings = batch();
    for (const s of SEEDS) expect(strings).toContain(s);
    for (const c of 'abcdefghijklmnopqrstuvwxyzI-\'"`') expect(ALPHABET).toContain(c);
    expect(random().some((s) => /[a-z]/.test(s))).toBe(true);
    // The input alphabet is ASCII, so NFKC leaves every input unchanged.
    for (const s of strings) expect(s.normalize('NFKC')).toBe(s);
  });
});

describe.skipIf(!ready)(
  'EXP-046 criterion 1: random and mutated text-emitter strings come out of the PDF as typed',
  () => {
    it('compiles the batch and finds each input, unchanged, as one line of the PDF text', async () => {
      const strings = batch();
      expect(strings.length).toBeGreaterThanOrEqual(SEEDS.length + LIGATURES.length + 60);
      const body: J[] = strings.map((s) => para(s));
      const c = await convertAndCompile(doc(body), {
        profile: 'preview',
        title: 'emit-fuzz-compile',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
      const text = pdfText(c.compile.pdf);
      if (text === null) throw new Error('pdftotext is not installed or failed');
      const out = new Set(lines(text));
      const missing = strings.filter((s) => !out.has(s));
      // A string the compile lost is stored as a fixture of the emitter corpus (criterion 5).
      for (const input of missing) storeFixture(CORPUS_DIR, { emitter: 'text', input });
      expect(missing).toEqual([]);
    }, 600_000);
  },
);
