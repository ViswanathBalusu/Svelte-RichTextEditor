// FE-126 criterion 4: the element's axe runs are handed to the conformance report in the form it reads
// (`AxeRecord`, packages/ui/src/a11y-report/report.ts). The hand-over writes one JSON line per run to
// the file `DOCEDIT_AXE_RESULTS` names, and nothing without it.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { axeRecord, handOverAxe } from '../e2e/axe-results.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const page = (name: string, version: string) =>
  ({
    context: () => ({
      browser: () => ({ browserType: () => ({ name: () => name }), version: () => version }),
    }),
  }) as never;

describe('FE-126 criterion 4: the axe results go to the conformance report', () => {
  it('makes a record with the fields the report reads, and the distinct rules', () => {
    const record = axeRecord('chromium', '140.0', 'a > b', [
      { id: 'label' },
      { id: 'label' },
      { id: 'region' },
    ]);
    expect(Object.keys(record).sort()).toEqual([
      'browser',
      'rules',
      'test',
      'version',
      'violations',
    ]);
    expect(record).toEqual({
      browser: 'chromium',
      version: '140.0',
      test: 'a > b',
      violations: 3,
      rules: ['label', 'region'],
    });
  });

  it('appends one line for each run to the file the variable names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fe126-'));
    dirs.push(dir);
    const file = join(dir, 'axe.jsonl');
    const info = { titlePath: ['spec.ts', 'FE-126 states', 'editing'] };
    handOverAxe(page('webkit', '26.0'), info, [], { DOCEDIT_AXE_RESULTS: file });
    handOverAxe(page('webkit', '26.0'), info, [{ id: 'color-contrast' }], {
      DOCEDIT_AXE_RESULTS: file,
    });
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      browser: 'webkit',
      version: '26.0',
      test: 'FE-126 states > editing',
      violations: 0,
      rules: [],
    });
    expect(lines[1]).toMatchObject({ violations: 1, rules: ['color-contrast'] });
  });

  it('writes nothing, and no file, without the variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fe126-'));
    dirs.push(dir);
    expect(handOverAxe(page('chromium', '1'), { titlePath: ['a', 'b'] }, [], {})).toBeNull();
    expect(existsSync(join(dir, 'axe.jsonl'))).toBe(false);
  });
});
