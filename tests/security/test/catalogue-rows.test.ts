/**
 * SEC-060 (criteria 1 and 2) — the authorisation matrix and the error registry are machine-readable
 * and every entry carries what the build needs: a row with an identifier, a code with its surfaces,
 * its retryability and its client action (05 §5.8; 07 §12). The negative-test check of criterion 3
 * and the provocation check of criterion 4 are not written yet: they need tags on the tests, which
 * the suites do not carry (see the story Notes).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as unknown;

interface MatrixRow {
  row: number;
  id: string;
  operation: string;
  requirement: unknown;
}
interface Registry {
  errors: Array<{ code: string; surfaces: string[]; retryable: string; clientAction: string }>;
}

const matrix = (read('../../../spec/permissions/permissions-1.json') as { matrix: MatrixRow[] })
  .matrix;
const registry = read('../../../spec/dep/dep-1.registry.json') as Registry;

describe('SEC-060 the authorisation matrix and the error registry are catalogued', () => {
  it('gives every authorisation row a unique identifier and a number, and a requirement', () => {
    expect(matrix.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    const numbers = new Set<number>();
    for (const r of matrix) {
      expect(r.id, `row ${r.row} id`).toMatch(/^[a-z][a-z0-9.-]*$/);
      expect(ids.has(r.id), `${r.id} is unique`).toBe(false);
      expect(numbers.has(r.row), `row ${r.row} is unique`).toBe(false);
      ids.add(r.id);
      numbers.add(r.row);
      expect(r.operation, `${r.id} operation`).toBeTruthy();
      expect(r.requirement, `${r.id} requirement`).toBeTruthy();
    }
  });

  it('gives every error code an identifier, its surfaces, its retryability and its client action', () => {
    expect(registry.errors.length).toBeGreaterThan(0);
    const codes = new Set<string>();
    for (const e of registry.errors) {
      expect(e.code, 'code').toMatch(/^[a-z][a-z0-9_]*$/);
      expect(codes.has(e.code), `${e.code} is unique`).toBe(false);
      codes.add(e.code);
      expect(e.surfaces.length, `${e.code} surfaces`).toBeGreaterThan(0);
      expect(e.retryable, `${e.code} retryable`).toBeTruthy();
      expect(e.clientAction, `${e.code} client action`).toBeTruthy();
    }
  });
});
