// The `history` profile against the reference service (PRO-119). The service is started with
// `history` and `comments` in DOCEDIT_FEATURES, as an operator announces them (a comment is made in
// the region-restore scenario). The history listing (`GET /documents/{id}/history`)
// is served since HIS-026, and `history.gate.history-list-and-versions` runs it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe.skipIf(skip)('history profile against the reference service (PRO-119)', () => {
  let target: StartedTarget;
  let report: KitReport;

  beforeAll(async () => {
    target = await startReference({
      env: {
        DOCEDIT_FEATURES: 'presence,regions,suggest-enforced,read-restrictions,history,comments',
      },
    });
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['history'],
    });
  }, 600_000);

  afterAll(async () => {
    await target?.stop();
  });

  const outcome = (id: string) =>
    report.profiles.flatMap((p) => p.scenarios).find((x) => x.id === id);

  it('runs the profile for a server that announces history', () => {
    const p = report.profiles.find((x) => x.id === 'history');
    expect(p?.outcome, p?.reason ?? '').not.toBe('skipped');
  });

  it.each([
    [
      'history.reads.versions-diff-attribution',
      'versions, comparison and attribution (criterion 1)',
    ],
    ['history.gate.every-route-with-a-seq', 'a seq below the gate is refused (criterion 2)'],
    [
      'history.gate.history-list-and-versions',
      'the list and a version refuse a seq below the gate (HIS-026)',
    ],
    [
      'history.gate.settings-matrix',
      'each setting and role: refused below the gate, served above, unknown person (HIS-026 criteria 3 to 5)',
    ],
    ['history.restore.dry-run', 'a dry run stores nothing (criterion 3)'],
    ['history.restore.region', 'a region restore keeps the rest and not the grants (criterion 3)'],
    [
      'history.restore.region-attribution',
      'a region restore keeps the authors of the blocks it does not touch (criterion 3, HIS-018)',
    ],
    ['history.read-marker.forward-only', 'a read marker moved backwards stays (criterion 4)'],
  ])('%s: %s', (id) => {
    const s = outcome(id);
    expect(s?.outcome, JSON.stringify(s?.failure ?? s)).toBe('passed');
  });
});
