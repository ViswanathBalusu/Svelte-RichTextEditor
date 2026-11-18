// PRM-058 criterion 8: the negative tests of the remaining matrix rows (07 §12 rows 2, 4, 5, 8, 9,
// 10, 11 and 12) are scenarios of the profiles `history`, `comments`, `exports` and `leases`, and
// they pass against the reference service when it announces the features of those profiles. The
// service is started with `history`, `comments`, `exports` and `leases` in DOCEDIT_FEATURES, as an
// operator announces them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROFILES } from '../src/profiles/index.ts';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

/** Each PRM-058 row and the scenario that holds its negative test. */
const ROWS: ReadonlyArray<readonly [row: string, scenario: string]> = [
  ['rows 2, 8, 9, 10 (history)', 'history.matrix.refusals'],
  ['row 2 (the gate at every route with a seq)', 'history.gate.every-route-with-a-seq'],
  [
    'row 2 (the history list and a version below the gate)',
    'history.gate.history-list-and-versions',
  ],
  ['row 4 (starting a thread needs comment)', 'comments.permissions.comment-scope'],
  ['rows 4 and 5 (reply, resolve, assign, delete)', 'comments.permissions.thread-actions'],
  ['row 12 (no-export and the other export refusals)', 'exports.refusals'],
  ['row 11 (a lease needs edit)', 'leases.acquire-needs-edit'],
  ['row 10 (a lease is broken with manage)', 'leases.break-needs-manage'],
];

describe('the matrix scenarios are in the profiles they are tagged for', () => {
  it.each(ROWS)('%s: %s', (_row, id) => {
    const profile = id.split('.')[0]!;
    const p = PROFILES.find((x) => x.id === profile);
    expect(p?.scenarios.map((s) => s.id)).toContain(id);
  });

  it('the leases profile has scenarios and is no longer pending', () => {
    const p = PROFILES.find((x) => x.id === 'leases');
    expect(p?.scenarios.length).toBeGreaterThan(0);
    expect(p?.pending).toBeUndefined();
  });
});

describe.skipIf(skip)('the matrix scenarios against the reference service (PRM-058)', () => {
  let target: StartedTarget;
  let report: KitReport;

  beforeAll(async () => {
    target = await startReference({
      env: {
        DOCEDIT_FEATURES:
          'presence,regions,suggest-enforced,read-restrictions,history,comments,exports,leases',
      },
    });
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['history', 'comments', 'exports', 'leases'],
    });
  }, 600_000);

  afterAll(async () => {
    await target?.stop();
  });

  it.each(ROWS)('%s: %s passes', (_row, id) => {
    const s = report.profiles.flatMap((p) => p.scenarios).find((x) => x.id === id);
    expect(s?.outcome, JSON.stringify(s?.failure ?? s?.reason ?? s)).toBe('passed');
  });
});
