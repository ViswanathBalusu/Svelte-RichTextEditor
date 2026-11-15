// EXP-007 criterion 5: the capacity sheet (CAPACITY.md) plans workers from one core and up to
// 1.5 GiB of memory for each running job (09 §8). The sheet is read here: its planning unit is the
// sandbox's own limits, and every row of its worked examples is what capacity.ts computes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jobsPerNode, nodesFor, PER_RUNNING_JOB } from './capacity.ts';
import { LIMITS, sandboxArgs } from './sandbox.ts';

const sheet = readFileSync(new URL('../CAPACITY.md', import.meta.url), 'utf8');
const spec = readFileSync(
  new URL('../../../docs/spec/09-export-latex.md', import.meta.url),
  'utf8',
);

describe('the capacity sheet of the export workers (EXP-007 criterion 5)', () => {
  it('plans one core and up to 1.5 GiB for each running job, as 09 §8 says', () => {
    expect(spec).toContain(
      'Capacity planning starts from one core and up to 1.5 GiB of memory per running job.',
    );
    expect(sheet).toContain('**one core and up to 1.5 GiB of memory for each running job**');
    expect(PER_RUNNING_JOB).toEqual({ cores: 1, memoryGiB: 1.5 });
  });

  it('takes the planning unit from the limits every sandbox runs under', () => {
    expect(PER_RUNNING_JOB.cores).toBe(LIMITS.cpus);
    expect(PER_RUNNING_JOB.memoryGiB * 1024).toBe(LIMITS.memoryMiB);
    const args = sandboxArgs('docedit-job-capacity-test');
    for (const flag of ['--cpus=1', '--memory=1536m', '--memory-swap=1536m']) {
      expect(args).toContain(flag);
      expect(sheet).toContain(flag.replace('--memory-swap=1536m', 'no swap'));
    }
  });

  it('gives worked examples that are the arithmetic of capacity.ts', () => {
    const rows = [
      ...sheet.matchAll(/^\| ([\d.]+) \| ([\d.]+) \| ([\d.]+) \| ([\d.]+) \| (\d+) \| (\d+) \|$/gm),
    ];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      const [cores, memoryGiB, reservedCores, reservedMemoryGiB, jobs, nodes] = r
        .slice(1)
        .map(Number) as [number, number, number, number, number, number];
      const node = { cores, memoryGiB, reservedCores, reservedMemoryGiB };
      expect(jobsPerNode(node), r[0]).toBe(jobs);
      expect(nodesFor(10, node), r[0]).toBe(nodes);
    }
    // Both limits bind somewhere in the examples: cores in one row, memory in another.
    const binding = rows.map((r) => {
      const [c, m, rc, rm] = r.slice(1).map(Number) as [number, number, number, number];
      return c - rc <= (m - rm) / 1.5 ? 'cores' : 'memory';
    });
    expect(new Set(binding)).toEqual(new Set(['cores', 'memory']));
  });

  it('rounds down for a node and up for the nodes, and refuses a node too small for one job', () => {
    expect(jobsPerNode({ cores: 4, memoryGiB: 5.9 })).toBe(3);
    expect(jobsPerNode({ cores: 1, memoryGiB: 1.4 })).toBe(0);
    expect(jobsPerNode({ cores: 2, memoryGiB: 8, reservedCores: 3 })).toBe(0);
    expect(nodesFor(0, { cores: 1, memoryGiB: 1 })).toBe(0);
    expect(nodesFor(9, { cores: 4, memoryGiB: 8 })).toBe(3);
    expect(() => nodesFor(1, { cores: 1, memoryGiB: 1.4 })).toThrow(RangeError);
    expect(() => nodesFor(1.5, { cores: 4, memoryGiB: 8 })).toThrow(RangeError);
    expect(() => jobsPerNode({ cores: Number.NaN, memoryGiB: 8 })).toThrow(RangeError);
  });
});
