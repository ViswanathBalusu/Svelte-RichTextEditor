// The input-method matrix covers the required inputs and runs in every editor, with and without
// remote commits (FE-123, criteria 1 and 2 as definition; the browser runs are the e2e suites).
import { describe, expect, it } from 'vitest';
import {
  type BrowserFamily,
  DRIVER_FACTS,
  INPUT_METHOD_MATRIX,
  MATRIX_EDITORS,
  MATRIX_REMOTE_MODES,
  driverFromFacts,
  matrixRuns,
} from './input-method-matrix.ts';

const FAMILIES: readonly BrowserFamily[] = ['chromium', 'gecko', 'webkit'];
const ALL_MANUAL = { chromium: 'manual', gecko: 'manual', webkit: 'manual' };

describe('the input-method matrix (FE-123 criterion 1)', () => {
  it('covers Japanese, Chinese and Korean composition', () => {
    for (const language of ['ja', 'zh', 'ko'] as const) {
      expect(
        INPUT_METHOD_MATRIX.some((c) => c.kind === 'composition' && c.language === language),
        `composition in ${language}`,
      ).toBe(true);
    }
  });

  it('covers dead keys', () => {
    expect(INPUT_METHOD_MATRIX.some((c) => c.kind === 'dead-key')).toBe(true);
  });

  it('covers one Android and one iOS on-screen keyboard', () => {
    expect(
      INPUT_METHOD_MATRIX.some((c) => c.kind === 'mobile-keyboard' && /Android/.test(c.method)),
    ).toBe(true);
    expect(
      INPUT_METHOD_MATRIX.some((c) => c.kind === 'mobile-keyboard' && /iOS/.test(c.method)),
    ).toBe(true);
  });

  it('has unique identifiers and non-empty sequences', () => {
    const ids = INPUT_METHOD_MATRIX.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of INPUT_METHOD_MATRIX) {
      expect(c.steps.length, c.id).toBeGreaterThan(0);
      expect(c.commit.length, c.id).toBeGreaterThan(0);
    }
  });
});

describe('the drivers follow what the browsers allow (spike S1; FE-123 criterion 3)', () => {
  it('marks a case automated only where the recorded driver facts allow it', () => {
    for (const c of INPUT_METHOD_MATRIX)
      for (const family of FAMILIES)
        expect(c.drivers[family], `${c.id} in ${family}`).toBe(driverFromFacts(c.kind, family));
  });

  it('sends every dead-key case to the manual pass in every browser', () => {
    const deadKeys = INPUT_METHOD_MATRIX.filter((c) => c.kind === 'dead-key');
    expect(deadKeys.length).toBeGreaterThan(0);
    for (const c of deadKeys) expect(c.drivers).toEqual(ALL_MANUAL);
  });

  it('keeps stepwise compositions manual in Firefox, which only commits in one step', () => {
    expect(DRIVER_FACTS.commitOnlyComposition.gecko).toBe(true);
    expect(DRIVER_FACTS.stepwiseComposition.gecko).toBe(false);
    for (const c of INPUT_METHOD_MATRIX.filter((m) => m.kind === 'composition')) {
      expect(c.drivers.gecko, c.id).toBe('manual');
      expect(c.note, c.id).toMatch(/one-step commit/);
    }
  });
});

describe('the matrix runs (FE-123 criterion 2)', () => {
  it('expands each case into every editor, with and without remote commits', () => {
    const runs = matrixRuns();
    expect(runs).toHaveLength(
      INPUT_METHOD_MATRIX.length * MATRIX_EDITORS.length * MATRIX_REMOTE_MODES.length,
    );
    expect(new Set(MATRIX_EDITORS)).toEqual(new Set(['main', 'footnote', 'header']));
    expect(new Set(MATRIX_REMOTE_MODES)).toEqual(new Set(['none', 'during-composition']));
    const keys = new Set(runs.map((r) => `${r.case.id}|${r.editor}|${r.remote}`));
    expect(keys.size).toBe(runs.length);
  });
});
