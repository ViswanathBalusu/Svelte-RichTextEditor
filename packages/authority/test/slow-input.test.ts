/**
 * SEC-028 criterion 5 (authority fuzz targets): an input over its time limit fails the property
 * and is stored as JSON; an input within the limit is not stored.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { storeIfSlow } from './slow-input.ts';

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'sec028-authority-'));
  dirs.push(d);
  return d;
};

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('SEC-028 authority fuzz inputs over the time limit are stored', () => {
  it('fails and stores the input with its timing when the input is over the limit', () => {
    const storeDir = join(tempDir(), 'slow-inputs');
    const input = { base: 0, steps: [{ stepType: 'replace', from: 1, to: 2 }] };
    expect(() => storeIfSlow('authority-fuzz', input, 2_500, { limitMs: 2_000, storeDir })).toThrow(
      /authority-fuzz took 2500\.0 ms on one input .*input stored at/,
    );
    const files = readdirSync(storeDir);
    expect(files).toHaveLength(1);
    const stored = JSON.parse(readFileSync(join(storeDir, files[0]!), 'utf8')) as {
      target: string;
      limitMs: number;
      elapsedMs: number;
      input: unknown;
    };
    expect(stored.target).toBe('authority-fuzz');
    expect(stored.limitMs).toBe(2_000);
    expect(stored.elapsedMs).toBe(2_500);
    expect(stored.input).toEqual(input);
  });

  it('keeps non-finite numbers in the stored input', () => {
    const storeDir = join(tempDir(), 'slow-inputs');
    expect(() =>
      storeIfSlow('authority-fuzz', { to: Number.POSITIVE_INFINITY }, 5, {
        limitMs: 1,
        storeDir,
      }),
    ).toThrow(/input stored at/);
    const [file] = readdirSync(storeDir);
    expect(readFileSync(join(storeDir, file!), 'utf8')).toContain('"Infinity"');
  });

  it('does nothing and stores nothing when the input is within the limit', () => {
    const storeDir = join(tempDir(), 'slow-inputs');
    expect(() =>
      storeIfSlow('authority-fuzz', { n: 1 }, 2_000, { limitMs: 2_000, storeDir }),
    ).not.toThrow();
    expect(existsSync(storeDir)).toBe(false);
  });
});
