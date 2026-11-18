// The `fault-injection` profile against the reference service (PRO-126). The service is started in
// test mode (`DOCEDIT_TEST_MODE`, `DOCEDIT_ENVIRONMENT=test`), as an operator starts it for a
// conformance run: it announces `test-hooks`, and the profile uses the hooks at `/_test/`. The log
// is in memory, so the rewind hook works. Without test mode the same service announces no hooks and
// the profile is skipped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe.skipIf(skip)('fault-injection profile against the reference service (PRO-126)', () => {
  let target: StartedTarget;
  let report: KitReport;

  beforeAll(async () => {
    target = await startReference({
      env: { DOCEDIT_TEST_MODE: 'true', DOCEDIT_ENVIRONMENT: 'test' },
    });
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: true,
      profiles: ['fault-injection'],
    });
  }, 600_000);

  afterAll(async () => {
    await target?.stop();
  });

  const outcome = (id: string) =>
    report.profiles.flatMap((p) => p.scenarios).find((x) => x.id === id);

  it('announces test-hooks in test mode, so the profile runs', () => {
    expect(report.target.features).toContain('test-hooks');
    const p = report.profiles.find((x) => x.id === 'fault-injection');
    expect(p?.outcome, p?.reason ?? '').not.toBe('skipped');
  });

  it.each([
    [
      'fault-injection.durability',
      'no commit is acknowledged before it is stored; a killed room loses none (criterion 1)',
    ],
    [
      'fault-injection.fencing',
      'a fenced room closes its channels unavailable and no commit is stored twice (criterion 2)',
    ],
    [
      'fault-injection.rewind',
      'a rewound log gives catchUp reload for the new incarnation (criterion 3)',
    ],
    [
      'fault-injection.grants-revision',
      'a lost grants announcement never lets a commit through under the old grants (criterion 4)',
    ],
    [
      'fault-injection.rolling-restart',
      'a restarted node sends goaway and 4503, and a client that follows the hint loses no acknowledged commit (PRO-024 criterion 6)',
    ],
  ])('%s passes: %s', (id) => {
    const r = outcome(id);
    expect(r?.outcome, JSON.stringify(r?.failure ?? r?.reason)).toBe('passed');
  });

  it('passes as a whole', () => {
    expect(report.ok, JSON.stringify(report.profiles[0]?.scenarios.map((x) => x.failure))).toBe(
      true,
    );
  });
});

describe.skipIf(skip)('the same service without test mode (PRO-126 criterion 5)', () => {
  let target: StartedTarget;
  beforeAll(async () => {
    target = await startReference();
  }, 60_000);
  afterAll(async () => {
    await target?.stop();
  });

  it('announces no test hooks, and the profile is skipped with the reason', async () => {
    const report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['fault-injection'],
    });
    expect(report.target.features).not.toContain('test-hooks');
    const p = report.profiles[0]!;
    expect(p.outcome).toBe('skipped');
    expect(p.reason).toMatch(/does not announce `test-hooks`/);
    expect(report.ok).toBe(true);
  });
});
