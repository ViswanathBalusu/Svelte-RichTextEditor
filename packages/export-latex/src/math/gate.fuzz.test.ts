import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fuzzAndStore } from '../../test/gate-regressions.ts';
import { mathGate } from './gate.ts';

/**
 * Fuzzing of the math gate (EXP-053). The seeds of known attacks are given to every property as
 * `examples`, which fast-check runs before its random cases in every run (criterion 4).
 */

const SEEDS = [
  '\\text{50% of}',
  '\\colorbox{white}{99}',
  '\\input file',
  '^^5c input',
  '\\hspace{99em}',
  '\\expandafter\\def\\csname a\\endcsname{x}',
  '\\write18{ls}',
  '{'.repeat(51) + 'x' + '}'.repeat(51),
  'x'.repeat(4001),
];

/** Fragments that a grammar-based generator combines: valid TeX, attacks and broken TeX. */
const FRAGMENTS = [
  '\\frac',
  '{',
  '}',
  '^',
  '_',
  'x',
  '1',
  ' ',
  '\\def',
  '\\input',
  '\\colorbox',
  '\\kern',
  '\\hspace{',
  '3em',
  '-1pt',
  '&',
  '\\\\',
  '%',
  '#',
  '~',
  '\\begin{aligned}',
  '\\begin{align}',
  '\\end{aligned}',
  '\\end{align}',
  '^^5c',
  '\\expandafter',
  '\\alpha',
  '\\sum',
  '\\left(',
  '\\right)',
  '\\,',
  '\\text{',
  '\\rlap',
  '\\cancel',
  '\\',
  'é',
  '∑',
  '\u0000',
];

const grammarArb = fc
  .array(fc.constantFrom(...FRAGMENTS), { maxLength: 40 })
  .map((parts) => parts.join(''));
const randomArb = fc.string({ maxLength: 300 });
const unicodeArb = fc.string({ unit: 'grapheme', maxLength: 200 });
/** Mutations of a seed: one character removed, replaced or inserted. */
const mutatedArb = fc
  .tuple(
    fc.constantFrom(...SEEDS),
    fc.nat(),
    fc.constantFrom(...FRAGMENTS, '', '\\', '{', '}', '%'),
  )
  .map(([seed, at, insert]) => {
    const i = seed.length === 0 ? 0 : at % (seed.length + 1);
    return seed.slice(0, i) + insert + seed.slice(i + 1);
  });
const inputArb = fc.oneof(grammarArb, randomArb, unicodeArb, mutatedArb);

/**
 * The properties are the named checks of `test/gate-regressions.ts`. A failing run stores its
 * shrunk input in `test/math-gate-regressions.json` (criterion 5), and every run gives the stored
 * inputs and the seeds to the property first.
 */
describe('math gate fuzzing (EXP-053 criterion 1)', () => {
  it('never throws, and decides each input within a bounded time', () => {
    fuzzAndStore('bounded-decision', inputArb, SEEDS);
  });
});

describe('math gate fuzzing (EXP-053 criterion 2, part)', () => {
  it('accepts only control words that are on the allow-list', () => {
    // The compile half of this criterion (the token-stream trace) needs the TeX engine and is
    // not run here. This is its lexical half: every control word of an accepted value is listed.
    fuzzAndStore('allow-listed-words', inputArb, SEEDS);
  });
});

describe('math gate fuzzing (EXP-053 criterion 3)', () => {
  it('accepts only what KaTeX in strict mode also accepts', () => {
    fuzzAndStore('katex-accepts', inputArb, SEEDS);
  });
});

describe('math gate fuzzing (EXP-053 criterion 4, seeds)', () => {
  it.each(SEEDS)('refuses the seed %s', (seed) => {
    expect(mathGate(seed, false).ok).toBe(false);
  });

  it('refuses a very large \\hspace whatever its unit', () => {
    for (const unit of ['pt', 'bp', 'mm', 'cm', 'in', 'em', 'ex']) {
      expect(mathGate(`a\\hspace{99${unit}} b`, false).ok).toBe(false);
    }
  });
});
