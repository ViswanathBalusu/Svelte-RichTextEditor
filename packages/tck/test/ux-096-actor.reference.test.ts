// The negative scenarios of DEP-Actor (UX-096 criterion 5; owner decision 174) against the
// reference service, started as an operator runs it. A user token's header changes nothing, and a
// service credential's header must name the user by an opaque identifier.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe.skipIf(skip)('the DEP-Actor scenarios of the authz profile (UX-096)', () => {
  let target: StartedTarget;
  let report: KitReport;

  beforeAll(async () => {
    target = await startReference();
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['authz'],
    });
  }, 600_000);

  afterAll(async () => {
    await target?.stop();
  });

  const outcome = (id: string) =>
    report.profiles.flatMap((p) => p.scenarios).find((s) => s.id === id);

  it('a user token that names another user in DEP-Actor stays the token holder', () => {
    const s = outcome('authz.actor.user-token');
    expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
  });

  it('a malformed DEP-Actor on a service call is refused as validation_failed', () => {
    const s = outcome('authz.actor.opaque');
    expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
  });
});
