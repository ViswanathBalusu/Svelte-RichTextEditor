// The `history` profile against the reference service (PRO-119). The service is started with
// `history` and `comments` in DOCEDIT_FEATURES, as an operator announces them (a comment is made in
// the region-restore scenario). The history listing (`GET /documents/{id}/history`) is not served,
// so it has no scenario (see the Notes of PRO-119).
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

  // The reference service attributes the whole document to the user who restores a region (ADR
  // 0373: it keeps no saved attribution maps), so the kit's attribution scenario fails against it.
  // The test says so, and turns red when the service keeps the authors, so that PRO-119 criterion 3
  // can then be ticked.
  it('history.restore.region-attribution: fails until the service keeps the authors of untouched blocks', () => {
    const s = outcome('history.restore.region-attribution');
    expect(s?.outcome, JSON.stringify(s)).toBe('failed');
    expect(JSON.stringify(s?.failure)).toContain('the authors of the intro are as they were');
  });

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
    ['history.restore.dry-run', 'a dry run stores nothing (criterion 3)'],
    ['history.restore.region', 'a region restore keeps the rest and not the grants (criterion 3)'],
    ['history.read-marker.forward-only', 'a read marker moved backwards stays (criterion 4)'],
  ])('%s: %s', (id) => {
    const s = outcome(id);
    expect(s?.outcome, JSON.stringify(s?.failure ?? s)).toBe('passed');
  });
});
