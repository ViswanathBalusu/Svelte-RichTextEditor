/**
 * The demonstrator of each row of the tier "through ports and extensions" (UX-002 criterion 3;
 * 13 §2, §6, §7). The report names what demonstrates the row, or states that none exists; a row
 * with no entry is reported as a problem rather than passing silently.
 */
import { describe, expect, it } from 'vitest';
import { DEMONSTRATORS } from '../src/parity/demonstrators.ts';
import { PROFILE, type ProfileRow } from '../src/parity/profile.ts';
import { parityReport } from '../src/parity/status.ts';

const PORTS = PROFILE.filter((row) => row.tier === 'ports-and-extensions');

describe('the report names the demonstrator of every ports-and-extensions row (UX-002, criterion 3)', () => {
  it('gives every row of the tier a demonstrator entry, and no other row one', () => {
    expect(PORTS.length).toBeGreaterThan(0);
    for (const row of PORTS) expect(DEMONSTRATORS.has(row.id), row.id).toBe(true);
    const ids = new Set(PORTS.map((row) => row.id));
    for (const id of DEMONSTRATORS.keys()) expect(ids.has(id), id).toBe(true);
  });

  it('puts the demonstrator on each row of the tier in the report, and on no other row', () => {
    const report = parityReport(PROFILE, new Map());
    for (const row of report.rows) {
      if (row.tier === 'ports-and-extensions') {
        expect(row.demonstrator, row.id).toEqual(DEMONSTRATORS.get(row.id));
      } else {
        expect(row.demonstrator, row.id).toBeUndefined();
      }
    }
  });

  it('states that none exists, with a reason, when no port or reference extension ships', () => {
    for (const [id, demonstrator] of DEMONSTRATORS) {
      if (demonstrator.state === 'none')
        expect(demonstrator.reason.trim().length, id).toBeGreaterThan(0);
      else expect(demonstrator.name.trim().length, id).toBeGreaterThan(0);
    }
  });

  it('reports a ports row with no demonstrator entry as a problem', () => {
    const extra: ProfileRow = {
      id: 'ports-row-without-entry',
      tier: 'ports-and-extensions',
      can: 'A test row.',
      items: [],
      spec: '13 §2',
      stories: [],
    };
    const report = parityReport([extra], new Map());
    expect(report.problems.some((p) => p.includes('ports-row-without-entry'))).toBe(true);
    expect(report.rows[0]?.demonstrator).toBeUndefined();
  });
});
