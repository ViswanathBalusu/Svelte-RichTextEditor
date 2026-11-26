// `workflow_active` on REST (PRO-115 criterion 3): the registry profile sends a workflow and then
// replaces it, and the reference service answers 409 `workflow_active` with the registry's surface
// and status.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe.skipIf(skip)('workflow_active in the registry profile (PRO-115)', () => {
  let target: StartedTarget;
  let report: KitReport;
  beforeAll(async () => {
    target = await startReference({});
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['registry'],
      scenarios: ['registry.workflow_active.rest'],
    });
  }, 300_000);
  afterAll(async () => {
    await target?.stop();
  });

  it('is provoked on REST: a sent workflow is not replaced', () => {
    const r = report.profiles
      .flatMap((p) => p.scenarios)
      .find((x) => x.id === 'registry.workflow_active.rest');
    expect(r?.outcome, JSON.stringify(r?.failure ?? r?.reason)).toBe('passed');
  });
});
