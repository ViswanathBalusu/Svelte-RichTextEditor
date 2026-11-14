/**
 * EXP-110, criterion 2 (memory half): each hostile package of `hostile-corpus.test.ts` is imported in
 * a fresh Node.js process (`exp-110-memory-child.ts`), and the growth of the peak resident set size
 * during the import is measured. The bound is a test bound chosen here, not a figure of the spec.
 * Measured on the machine that runs the test; the numbers are printed in the test output.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CASES, buildCase } from './exp-110-memory-cases.ts';
import { OUT_DIR } from './corpus.ts';

/** Test bound on the growth of the peak resident set size during one import, in kibibytes. */
const GROWTH_BOUND_KIB = 512 * 1024;
// fileURLToPath gives an absolute path on every platform (`E:\...` on Windows, `/home/...` on Linux).
const CHILD = fileURLToPath(new URL('./exp-110-memory-child.ts', import.meta.url));

interface Report {
  refused: boolean;
  message: string;
  ms: number;
  baseKiB: number;
  peakKiB: number;
}

describe('EXP-110 criterion 2: memory of the hostile corpus during import', () => {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const name of CASES) {
    it(`bounds the peak memory growth of the ${name} import`, () => {
      const file = join(OUT_DIR, `exp-110-${name}.docx`);
      writeFileSync(file, buildCase(name));
      const out = execFileSync(process.execPath, [CHILD, file], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
      });
      const report = JSON.parse(out.trim().split('\n').pop()!) as Report;
      const growth = report.peakKiB - report.baseKiB;
      console.info(
        `[EXP-110 memory] ${name}: refused=${report.refused} ms=${report.ms.toFixed(0)} ` +
          `baseKiB=${report.baseKiB} peakKiB=${report.peakKiB} growthKiB=${growth}`,
      );
      expect(report.ms).toBeLessThan(30_000);
      expect(growth).toBeLessThan(GROWTH_BOUND_KIB);
      if (report.refused) expect(report.message).toMatch(/^ImportError/);
    }, 150_000);
  }
});
