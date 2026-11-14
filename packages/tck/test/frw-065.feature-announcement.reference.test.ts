// FRW-065 criteria 1 and 4 (reference service half): the reference service announces `fields` only
// as the kit's profile maps it, and a channel that asks for a feature it does not announce is refused
// with `unsupported_feature`. Lane U-FRW-055-072. Criterion 5 (the mock backend implements the fields
// port) is not met here: the mock does not announce `fields` (packages/backend-mock).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { keep } from './targets/judge.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe.skipIf(skip)('FRW-065: feature announcement against the reference service', () => {
  let target: StartedTarget;
  let report: KitReport;
  beforeAll(async () => {
    target = await startReference();
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      scenarios: ['core.discovery.shape', 'core.channel.rejected.feature', 'fields.announce'],
      profiles: ['core', 'fields'],
    });
    keep('reference-feature-announce', report);
  }, 900_000);
  afterAll(async () => {
    await target?.stop();
  });

  const find = (id: string) => report.profiles.flatMap((p) => p.scenarios).find((s) => s.id === id);

  it('announces fields and the discovery shape passes (FRW-065 criterion 1)', () => {
    expect(report.target.features, 'announced features').toContain('fields');
    const s = find('fields.announce');
    expect(s?.outcome, s?.failure?.message ?? s?.reason ?? '').toBe('passed');
    expect(find('core.discovery.shape')?.outcome).toBe('passed');
  });

  it('refuses a channel that asks for an unannounced feature with unsupported_feature (FRW-065 criterion 4)', () => {
    const s = find('core.channel.rejected.feature');
    expect(s?.outcome, s?.failure?.message ?? s?.reason ?? '').toBe('passed');
  });
});
