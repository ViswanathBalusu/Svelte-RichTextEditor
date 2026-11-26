// FRW-065 criteria 1 and 4: the reference service announces `fields` as the kit's profile maps it, a
// relay (the kit's relay target, the `Relay` of @docedit/authority behind DEP) never does, and a channel
// that asks for a feature it does not announce is refused with `unsupported_feature`. The mock
// backend's half (criterion 5) is packages/backend-mock/test/fields.test.ts; the features that depend on
// what a service is built of (criterion 2) are services/document-service/test/control-plane/
// frw-065.features.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { keep } from './targets/judge.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';
import { startRelay } from './targets/relay-server.ts';

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

describe.skipIf(skip)('FRW-065 criterion 1: a relay never announces fields', () => {
  let target: StartedTarget;
  let report: KitReport;
  beforeAll(async () => {
    target = await startRelay();
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['core-relay'],
    });
  }, 120_000);
  afterAll(async () => {
    await target?.stop();
  });

  it('announces mode relay and none of the features of a document model', () => {
    expect(report.target.mode).toBe('relay');
    for (const f of ['fields', 'rules', 'workflow', 'sign', 'seal', 'regions', 'suggest-enforced'])
      expect(report.target.features, f).not.toContain(f);
    const s = report.profiles
      .flatMap((p) => p.scenarios)
      .find((x) => x.id === 'core-relay.discovery.mode-and-features');
    expect(s?.outcome, s?.failure?.message ?? s?.reason ?? '').toBe('passed');
  });

  it('is not given the fields profile: it needs a document model, so it is skipped', () => {
    const fields = report.profiles.find((p) => p.id === 'fields');
    expect(fields === undefined || fields.outcome === 'skipped').toBe(true);
  });
});
