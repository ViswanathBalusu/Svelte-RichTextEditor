/**
 * EXP-110 criterion 5: a failure that is found becomes a file in the corpus. Three parts:
 * - `saveRegression` writes the failing input under a name from its family and hash, once.
 * - `savingFailures`, which the fuzz test wraps every import in, saves the failing input and names it in
 *   the error it throws (checked with a simulated crash).
 * - Every file of `test/regressions/` is imported, within a bound, with a result or an `ImportError`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importDocx, ImportError } from '../src/index.ts';
import { regressionFiles, saveRegression, savingFailures } from './regressions.ts';

const BOUND_MS = 30_000;

describe('EXP-110 criterion 5: a failing input is added to the corpus', () => {
  it('saves an input once, under its family and hash, and lists it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exp-110-'));
    try {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const a = saveRegression(bytes, 'part mutation', dir);
      const b = saveRegression(bytes, 'part mutation', dir);
      expect(b).toBe(a);
      expect(a).toMatch(/part-mutation-[0-9a-f]{8}\.docx$/);
      expect([...readFileSync(a)]).toEqual([1, 2, 3, 4]);
      const other = saveRegression(new Uint8Array([9]), 'part mutation', dir);
      expect(regressionFiles(dir)).toEqual([a, other].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saves the input of a failed check and names the file in the error, and saves nothing otherwise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exp-110-'));
    try {
      const bytes = new Uint8Array([7, 7, 7]);
      await expect(savingFailures(bytes, 'fuzz', async () => 'fine', dir)).resolves.toBe('fine');
      expect(regressionFiles(dir)).toEqual([]);
      const failing = savingFailures(
        bytes,
        'fuzz',
        async () => {
          throw new TypeError('a crash');
        },
        dir,
      );
      await expect(failing).rejects.toThrow(
        /a crash \(the input is saved as .*fuzz-[0-9a-f]{8}\.docx/,
      );
      expect(regressionFiles(dir)).toHaveLength(1);
      expect([...readFileSync(regressionFiles(dir)[0]!)]).toEqual([7, 7, 7]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports every saved regression within a bound, with a result or an ImportError', async () => {
    for (const path of regressionFiles()) {
      const start = performance.now();
      try {
        await importDocx(new Uint8Array(readFileSync(path)));
      } catch (e) {
        expect(e, path).toBeInstanceOf(ImportError);
      }
      expect(performance.now() - start, path).toBeLessThan(BOUND_MS);
    }
  }, 600_000);
});
