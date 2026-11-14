// Linear-time patterns (FRW-014, FRW-018; ADR 0030 §5). The step counts are exact and the same in
// every engine; the timings show the same growth in Node.js (the authority's runtime) and in
// Chromium, Firefox and WebKit (the editor's engines). A backtracking engine takes exponential
// time on these pattern and input pairs.
import { describe, expect, it } from 'vitest';
import { LIMITS } from './limits.ts';
import { compilePattern, matchPattern, maxMatchSteps, type Pattern } from './pattern.ts';

const compiled = (source: string): Pattern => {
  const r = compilePattern(source);
  if (!r.ok) throw new Error(r.problem.message);
  return r.pattern;
};

const PATHOLOGICAL: Array<[string, (n: number) => string]> = [
  ['(a+)+b', (n) => 'a'.repeat(n)],
  ['(a|aa)*c', (n) => 'a'.repeat(n)],
  ['(a|a)*b', (n) => 'a'.repeat(n)],
  ['(.*a){10}', (n) => 'a'.repeat(9) + 'b'.repeat(n - 9)],
  ['(x+x+)+y', (n) => 'x'.repeat(n)],
  ['^(([a-z])+.)+[A-Z]([a-z])+$', (n) => 'aaaa'.repeat(n / 4)],
];
// Input lengths in code points, up to the 4 KiB target of FRW-018.
const SIZES = [512, 1024, 2048, 4096];

const timed = (p: Pattern, input: string, repeat = 3) => {
  let best = Infinity;
  let steps = 0;
  for (let i = 0; i < repeat; i++) {
    const t0 = performance.now();
    const r = matchPattern(p, input);
    best = Math.min(best, performance.now() - t0);
    steps = r.steps;
    expect(r.matched).toBe(false);
  }
  return { ms: best, steps };
};

describe('linear-time matching', () => {
  it('grows linearly with the input on pathological patterns (step counts)', () => {
    for (const [source, input] of PATHOLOGICAL) {
      const p = compiled(source);
      const steps = SIZES.map((n) => matchPattern(p, input(n)).steps);
      SIZES.forEach((n, i) =>
        expect(steps[i]!, `${source} at ${n}`).toBeLessThanOrEqual(maxMatchSteps(p, n)),
      );
      // Doubling the input never more than doubles the work, apart from the constant start-up.
      for (let i = 1; i < steps.length; i++) {
        const ratio = steps[i]! / steps[i - 1]!;
        expect(ratio, `${source}: ${steps[i - 1]} then ${steps[i]}`).toBeLessThanOrEqual(2.05);
      }
    }
  });

  it('grows linearly with the input on pathological patterns (time)', () => {
    const lines: string[] = [];
    for (const [source, input] of PATHOLOGICAL) {
      const p = compiled(source);
      matchPattern(p, input(SIZES[0]!)); // warm up
      const runs = SIZES.map((n) => timed(p, input(n)));
      lines.push(
        `${source}: ${runs.map((r, i) => `${SIZES[i]} cp ${r.ms.toFixed(2)} ms`).join(', ')}`,
      );
      // Generous bounds: timers are coarse in browsers. Linear growth is what the step counts prove;
      // this shows no runtime turns it into anything worse.
      expect(runs[3]!.ms, source).toBeLessThan(250);
      expect(runs[3]!.ms, source).toBeLessThan(Math.max(8 * runs[1]!.ms, 1) * 4 + 20);
    }
    console.log(`pattern timings, best of 3:\n${lines.join('\n')}`);
  });

  it('bounds the worst pattern the limits allow', () => {
    // The largest program: counted repetitions expanded up to the instruction limit.
    const p = compiled('(?:[a-z]{0,90}[0-9]{0,9}){5}x');
    expect(p.size).toBeLessThanOrEqual(LIMITS.patternProgram);
    const input = 'a'.repeat(4096);
    const r = matchPattern(p, input);
    expect(r.matched).toBe(false);
    expect(r.steps).toBeLessThanOrEqual(maxMatchSteps(p, 4096));
  });

  it('matches the whole value, by code point', () => {
    expect(matchPattern(compiled('[0-9]{5}'), '12345').matched).toBe(true);
    expect(matchPattern(compiled('[0-9]{5}'), '123456').matched).toBe(false);
    expect(matchPattern(compiled('.'), '\u{1F600}').matched).toBe(true);
    expect(matchPattern(compiled('..'), '\u{1F600}').matched).toBe(false);
    expect(matchPattern(compiled('a.c'), 'a\nc').matched).toBe(true);
  });

  it('names the construct it refuses', () => {
    const refused = (s: string) => {
      const r = compilePattern(s);
      return r.ok ? null : [r.problem.code, r.problem.construct];
    };
    expect(refused('(a)\\1')).toEqual(['pattern_unsupported', 'back-reference']);
    expect(refused('(?=a)')).toEqual(['pattern_unsupported', 'look-ahead']);
    expect(refused('(?<!a)b')).toEqual(['pattern_unsupported', 'look-behind']);
    expect(refused('a{101}')).toEqual(['pattern_limit', 'repetition count']);
    expect(refused('a'.repeat(LIMITS.patternLength + 1))).toEqual([
      'pattern_limit',
      'pattern length',
    ]);
  });
});
