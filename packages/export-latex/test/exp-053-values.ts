/**
 * Values that the math gate accepts, for the compile tests of EXP-053 (Node.js only): hand-written
 * ones, and a fixed-seed sample of generated ones. Shared by `exp-053-trace.compile.test.ts` (the
 * token trace) and `exp-053-paint.compile.test.ts` (the painting).
 */
import fc from 'fast-check';
import { mathGate } from '../src/math/gate.ts';

/** Values the gate accepts: hand-written ones, and a fixed-seed sample of generated ones. */
export const HAND = [
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
export const generated: string[] = fc
  .sample(generatedArb, { seed: 20261114, numRuns: 400 })
  .filter((v) => mathGate(v, true).ok)
  .slice(0, 4);

/** Every accepted value of the compile tests. */
export const ACCEPTED: readonly string[] = [...HAND, ...generated];
