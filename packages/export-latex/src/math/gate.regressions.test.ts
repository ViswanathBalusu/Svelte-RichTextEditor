import fc from 'fast-check';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  fuzzAndStore,
  loadRegressions,
  PROPERTIES,
  storeRegression,
} from '../../test/gate-regressions.ts';

/**
 * Regression fixtures of the math gate (EXP-053 criterion 5). A failure of a fuzz property is
 * stored as a fixture and replayed in every run, whether or not the fuzzer finds it again.
 */

describe('math gate regression fixtures (EXP-053 criterion 5)', () => {
  it('replays every stored fixture against the property that failed on it', () => {
    for (const f of loadRegressions()) {
      expect(PROPERTIES, `${f.property} is a known property`).toContain(f.property);
      expect(() => CHECKS[f.property](f.latex, f.display), JSON.stringify(f.latex)).not.toThrow();
    }
  });

  it('stores the shrunk input of a failing property in a fixture file, once, and replays it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docedit-gate-regressions-'));
    const file = join(dir, 'regressions.json');
    try {
      // A property that is broken on purpose: it refuses any input with a brace.
      const broken = (latex: string): void => {
        if (latex.includes('{')) throw new Error('a brace');
      };
      const arbitrary = fc.string({ maxLength: 20 });
      expect(() =>
        fuzzAndStore('katex-accepts', arbitrary, ['x', '{'], { file, check: broken }),
      ).toThrow(/Stored in/);
      const stored = loadRegressions(file);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        property: 'katex-accepts',
        latex: '{',
        message: 'a brace',
      });
      // The same failure is not stored twice; the stored input runs first on the next run.
      expect(() => fuzzAndStore('katex-accepts', arbitrary, [], { file, check: broken })).toThrow(
        /Already stored in/,
      );
      expect(loadRegressions(file)).toHaveLength(1);
      expect(storeRegression(stored[0]!, file)).toBe(false);
      // The file is JSON that a person can read.
      expect(JSON.parse(readFileSync(file, 'utf8')).fixtures).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives the stored inputs to the property before any random case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docedit-gate-regressions-'));
    const file = join(dir, 'regressions.json');
    try {
      storeRegression(
        { property: 'katex-accepts', latex: 'needle', display: true, message: 'seeded' },
        file,
      );
      const seen: string[] = [];
      const record = (latex: string, display: boolean): void => {
        seen.push(`${latex}|${String(display)}`);
      };
      fuzzAndStore('katex-accepts', fc.string({ maxLength: 5 }), ['seed'], {
        file,
        check: record,
        numRuns: 5,
      });
      expect(seen.slice(0, 3)).toEqual(['seed|false', 'seed|true', 'needle|true']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
