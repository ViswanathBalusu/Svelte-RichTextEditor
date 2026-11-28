/**
 * SEC-053 criterion 4: the upgrade gate names tests that exist. The gate itself
 * (`scripts/upgrade-gate.ts`) needs Podman and a candidate image; this checks, with no image,
 * that it runs the engine ledger and both reference comparisons, and that the ledger rule it
 * relies on (a changed base image needs a class release) is the one `exp-078-engine-ledger.test.ts`
 * checks.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = readFileSync(new URL('../scripts/upgrade-gate.ts', import.meta.url), 'utf8');
const listed = [...script.matchAll(/'((?:services|packages)\/[^']+\.test\.ts)'/g)].map(
  (m) => m[1]!,
);

describe('SEC-053 criterion 4: the upgrade gate', () => {
  it('runs the engine ledger and the two reference comparisons', () => {
    expect(listed).toEqual([
      'services/export-worker/src/exp-078-engine-ledger.test.ts',
      'services/export-worker/src/exp-078-reference.podman.test.ts',
      'packages/export-latex/src/exp-114-compare.compile.test.ts',
    ]);
  });
  it('names tests that exist', () => {
    for (const p of listed) expect(existsSync(root + p), p).toBe(true);
  });
  it('makes a skipped sandbox test a failure and takes the candidate image from its argument', () => {
    expect(script).toContain("DOCEDIT_REQUIRE_SANDBOX: '1'");
    expect(script).toContain('DOCEDIT_EXPORT_IMAGE: image');
  });
});
