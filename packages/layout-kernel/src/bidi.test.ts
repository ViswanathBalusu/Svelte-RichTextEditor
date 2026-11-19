/**
 * WASM-015: the bidirectional algorithm (UAX #9) in the kernel, through the package's wrapper, on
 * the real build in Node.js. The rules are tested in the crate (`crates/layout-kernel/src/bidi.rs`)
 * and against the browsers' own ordering in `e2e/wasm-015-bidi-browsers.spec.ts`; these tests check
 * what the wrapper promises: the paragraph direction, the levels, and visual runs that are ranges
 * of logical UTF-16 offsets, for a whole paragraph and for a line of it.
 */
import { describe, expect, it } from 'vitest';
import { kernelIsBuilt, loadNodeKernel } from '../node/index.ts';
import { KernelShapeError, type BidiDirection, type LayoutKernel } from './index.ts';

const built = kernelIsBuilt();
if (process.env['DOCEDIT_KERNEL_REQUIRED'] === '1' && !built)
  throw new Error('dist/ is not built: run build:wasm first');

const ALEF = 'א';
const BET = 'ב';

const runs = (
  kernel: LayoutKernel,
  text: string,
  direction: BidiDirection,
  from?: number,
  to?: number,
) => kernel.bidi.visualRuns(text, direction, from, to).map((r) => [r.start, r.end, r.level]);

describe.skipIf(!built)('bidirectional text in the kernel (WASM-015)', () => {
  it('takes the paragraph direction from dir, or from the first strong character', async () => {
    const kernel = await loadNodeKernel();
    const hebrew = `${ALEF}${BET} abc`;
    expect(kernel.bidi.levels(hebrew, 'auto').paragraphLevel).toBe(1);
    expect(kernel.bidi.levels(hebrew, 'ltr').paragraphLevel).toBe(0);
    expect(kernel.bidi.levels('abc', 'rtl').paragraphLevel).toBe(1);
    expect(kernel.bidi.levels('abc', 'auto').paragraphLevel).toBe(0);
    // No strong character: left to right.
    expect(kernel.bidi.levels('123 ()', 'auto').paragraphLevel).toBe(0);
    // An isolate hides what is inside it from the search.
    expect(kernel.bidi.levels(`⁧${ALEF}⁩abc`, 'auto').paragraphLevel).toBe(0);
  });

  it('gives a level for each UTF-16 unit, with a surrogate pair as one character', async () => {
    const kernel = await loadNodeKernel();
    // U+1E900 (Adlam, right to left) is two code units.
    const text = `a \u{1e900}\u{1e901} b`;
    const { levels } = kernel.bidi.levels(text, 'ltr');
    expect(levels.length).toBe(text.length);
    expect(Array.from(levels)).toEqual([0, 0, 1, 1, 1, 1, 0, 0]);
  });

  it('returns visual runs as ranges of logical offsets, left to right', async () => {
    const kernel = await loadNodeKernel();
    const text = `abc ${ALEF}${BET} def`;
    expect(runs(kernel, text, 'ltr')).toEqual([
      [0, 4, 0],
      [4, 6, 1],
      [6, 10, 0],
    ]);
    expect(kernel.bidi.visualRuns(text, 'ltr').map((r) => r.rtl)).toEqual([false, true, false]);
    // Right to left: the Latin word is raised and stands first; the Hebrew and the space after it follow.
    expect(runs(kernel, `${ALEF}${BET} abc`, 'rtl')).toEqual([
      [3, 6, 2],
      [0, 3, 1],
    ]);
    // A paragraph with nothing to reorder is one run.
    expect(runs(kernel, 'plain text', 'ltr')).toEqual([[0, 10, 0]]);
    expect(runs(kernel, '', 'ltr')).toEqual([]);
  });

  it('orders a line of a paragraph by its own levels, and puts its trailing space at the paragraph level', async () => {
    const kernel = await loadNodeKernel();
    const text = `${ALEF}${BET}${ALEF} abc ${ALEF}${BET}`;
    // The paragraph is right to left; the first line is the Hebrew word and its space.
    expect(runs(kernel, text, 'rtl', 0, 4)).toEqual([[0, 4, 1]]);
    // A line of left-to-right text that ends in a space: the space is at level 0 (L1).
    const ltr = `${ALEF}${BET}  `;
    expect(runs(kernel, ltr, 'ltr')).toEqual([
      [0, 2, 1],
      [2, 4, 0],
    ]);
    // The line may begin at a later offset: logical offsets stay those of the whole text.
    // Its trailing space is at the paragraph level (L1) and so stands first, on the left.
    expect(runs(kernel, text, 'rtl', 4, 8)).toEqual([
      [7, 8, 1],
      [4, 7, 2],
    ]);
  });

  it('keeps explicit embeddings, overrides and isolates in the runs they are in', async () => {
    const kernel = await loadNodeKernel();
    const levels = (t: string, d: BidiDirection = 'ltr') =>
      Array.from(kernel.bidi.levels(t, d).levels);
    expect(levels('‫a‬')).toEqual([0, 2, 2]);
    expect(levels('x⁧a⁩y')).toEqual([0, 0, 2, 0, 0]);
    expect(levels('‮abc‬').slice(1, 4)).toEqual([1, 1, 1]);
    // An Arabic-Indic digit resolves to level 2; an embedding after it is bounded by the explicit
    // level of the digit (0), not by its resolved level.
    expect(levels('٢‫ b2')).toEqual([2, 2, 1, 2, 2]);
  });

  it('refuses a line that is out of range or splits a surrogate pair', async () => {
    const kernel = await loadNodeKernel();
    const code = (call: () => unknown): string => {
      try {
        call();
      } catch (error) {
        return error instanceof KernelShapeError ? error.code : String(error);
      }
      return 'no error';
    };
    const text = `a\u{1e900}b`;
    expect(code(() => kernel.bidi.visualRuns(text, 'ltr', 0, 99))).toBe('bad_request');
    expect(code(() => kernel.bidi.visualRuns(text, 'ltr', 2, 1))).toBe('bad_request');
    expect(code(() => kernel.bidi.visualRuns(text, 'ltr', 2, 4))).toBe('bad_request');
    expect(code(() => kernel.bidi.visualRuns(text, 'ltr', 1, 3))).toBe('no error');
  });

  it('gives runs that tile the line, whatever the text', async () => {
    const kernel = await loadNodeKernel();
    const alphabet = [
      'a',
      'b',
      ALEF,
      BET,
      'ا',
      '1',
      '2',
      '١',
      ' ',
      '(',
      ')',
      ',',
      '-',
      '‪',
      '‫',
      '‬',
      '‭',
      '‮',
      '⁦',
      '⁧',
      '⁨',
      '⁩',
      '́',
    ];
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 400; i++) {
      let text = '';
      for (let k = 0, n = 1 + Math.floor(next() * 14); k < n; k++)
        text += alphabet[Math.floor(next() * alphabet.length)];
      for (const direction of ['ltr', 'rtl', 'auto'] as const) {
        const result = kernel.bidi.visualRuns(text, direction);
        const covered = new Array<number>(text.length).fill(0);
        for (const run of result) {
          expect(run.end, text).toBeGreaterThan(run.start);
          for (let at = run.start; at < run.end; at++) covered[at]!++;
        }
        expect(
          covered.every((c) => c === 1),
          `${direction} ${JSON.stringify(text)}`,
        ).toBe(true);
        expect(Array.from(kernel.bidi.levels(text, direction).levels).length).toBe(text.length);
      }
    }
  });
});
