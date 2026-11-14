// The fuzzer's failure path (PRO-116 criterion 4; lane V-PRO-103-119): a server that stalls must
// fail the fuzz run, the failure must name the seed, batch and input, and the report must keep the
// input that caused it. The stall is injected by the mock target (stallAfterPings), so this runs
// against a real DEP socket, not a stub of the profile.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startMock } from './targets/mock-server.ts';
import type { StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe.skipIf(skip)('fuzz: a stalled server fails the run and keeps the input (PRO-116)', () => {
  let target: StartedTarget;
  let report: KitReport;

  beforeAll(async () => {
    // No ping is answered, so the first probe after the first fuzzed frame finds a stall.
    target = await startMock({ stallAfterPings: 0 });
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['fuzz'],
      timeoutMs: 1500,
      fuzz: { budgetMs: 60_000, seed: 116, maxRuns: 200 },
    });
  }, 120_000);

  afterAll(async () => {
    await target?.stop();
  });

  it('fails the run when the server stops answering pings', () => {
    expect(report.ok).toBe(false);
    const fuzz = report.profiles.find((p) => p.id === 'fuzz');
    expect(fuzz?.outcome).not.toBe('skipped');
    const envelope = fuzz?.scenarios.find((s) => s.id === 'fuzz.envelope');
    expect(envelope?.outcome).toBe('failed');
  });

  it('names the seed, batch and input that produced the stall', () => {
    const envelope = report.profiles
      .find((p) => p.id === 'fuzz')
      ?.scenarios.find((s) => s.id === 'fuzz.envelope');
    const message = envelope?.failure?.message ?? '';
    expect(message).toMatch(/stalled/);
    expect(message).toContain('seed 116');
    expect(message).toMatch(/batch 0, input \d+/);
  });

  it('keeps the fuzzed input in the report', () => {
    const envelope = report.profiles
      .find((p) => p.id === 'fuzz')
      ?.scenarios.find((s) => s.id === 'fuzz.envelope');
    expect(envelope?.failure?.received).toBeTruthy();
    expect(envelope?.failure?.received?.length).toBeGreaterThan(0);
  });
});
