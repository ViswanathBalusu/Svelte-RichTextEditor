/**
 * The service's documentation lists each limit of a job with its value (EXP-071 criterion 4;
 * 09 §9.3 item 4). The values in README.md are compared with the ones the sandbox enforces
 * (`LIMITS` in sandbox.ts), so that a change to one without the other fails the suite.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIMITS } from './sandbox.ts';

const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
const MiB = 1024 * 1024;
const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Each limit, as the table row must read: its label and its value. */
const rows: Array<[string, string]> = [
  ['Wall clock for the whole job, all passes included', `${LIMITS.wallSeconds} seconds`],
  ['Wall clock for one pass', `${LIMITS.wallSeconds - 10} seconds`],
  ['CPU', `${LIMITS.cpus} core`],
  ['Memory, with no swap', `${LIMITS.memoryMiB / 1024} GiB (${LIMITS.memoryMiB} MiB)`],
  ['Processes', `${LIMITS.pids} processes`],
  ['Pages of the document', `${thousands(LIMITS.pages)} pages`],
  ['Output of the job', `${LIMITS.outputBytes / MiB} MiB of output`],
  ['Working directory', `${LIMITS.workMiB} MiB of working directory`],
];

describe('the service documentation lists every job limit with its value (EXP-071 criterion 4)', () => {
  it.each(rows)('lists "%s" with its value', (label, value) => {
    const row = readme.split('\n').find((l) => l.startsWith(`| ${label} |`));
    expect(row).toBeDefined();
    expect(row).toContain(`| ${value} |`);
  });

  it('lists the limits that the sandbox enforces and no others', () => {
    // Every key of LIMITS is covered by a row above, so that a new limit must be documented.
    const covered = new Set([
      'wallSeconds',
      'cpus',
      'memoryMiB',
      'pids',
      'outputBytes',
      'workMiB',
      'pages',
    ]);
    expect(new Set(Object.keys(LIMITS))).toEqual(covered);
  });
});
