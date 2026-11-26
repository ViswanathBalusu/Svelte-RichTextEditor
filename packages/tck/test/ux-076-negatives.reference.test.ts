// UX-076 criterion 4: the conformance kit's negative tests for the administration API. Every
// administration operation is called with no credential and with an unissued one (`authz.anonymous`,
// rows 13 and 14), with a user token (`authz.service`, `authz.operator`), and by a caller of another
// tenant (`authz.other-tenant`: a service credential of a second tenant, the optional kit input
// `otherCredential`). The run is against the reference service, which the kit reaches only through
// its discovery URL and the two credentials; the service seeds two tenants from its documented seed
// file (test/targets/reference.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEP1 } from '@docedit/protocol';
import { MATRIX } from '@docedit/authority';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { PROFILES } from '../src/profiles/index.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

const outcomesOf = (report: KitReport) =>
  Object.fromEntries(
    report.profiles
      .flatMap((p) => p.scenarios)
      .map((s) => [s.id, { outcome: s.outcome, failure: s.failure, reason: s.reason }] as const),
  );

describe('the scenarios name every administration operation (UX-076 criterion 4)', () => {
  const authz = PROFILES.find((p) => p.id === 'authz')!;
  const covered = (id: string) =>
    new Set(authz.scenarios.find((s) => s.id === `authz.${id}`)?.covers.operations ?? []);
  const label = (o: { method: string; path: string }) => `${o.method.toUpperCase()} ${o.path}`;
  const adminRoutes = MATRIX.filter((r) => r.id === 'service' || r.id === 'operator').flatMap(
    (r) => r.routes,
  );

  it('has the routes of rows 13 and 14 in the contract', () => {
    const known = new Set(DEP1.operations.map(label));
    for (const route of adminRoutes) expect(known.has(route), route).toBe(true);
  });

  it('calls every route of rows 13 and 14 with no credential', () => {
    const names = covered('anonymous');
    for (const route of adminRoutes) expect(names.has(route), route).toBe(true);
  });

  it('calls every route of row 13 with a user token and every route of row 14 with a service credential', () => {
    const service = covered('service');
    for (const route of MATRIX.find((r) => r.id === 'service')!.routes)
      expect(service.has(route), route).toBe(true);
    const operator = covered('operator');
    for (const route of MATRIX.find((r) => r.id === 'operator')!.routes)
      expect(operator.has(route), route).toBe(true);
  });

  it('calls the routes that address a resource by identifier with a second tenant credential', () => {
    const names = covered('other-tenant');
    for (const route of adminRoutes.filter((r) => r.includes('{'))) {
      // Routes keyed by an identifier that no tenant owns before it is made (a template, a bulk
      // send, a bundle export, a font by hash) answer not found to every caller.
      if (/\/(templates|bulk-sends|bundle-exports|tenant-fonts)/.test(route)) continue;
      expect(names.has(route), route).toBe(true);
    }
  });
});

describe.skipIf(skip)(
  'the administration API against the reference service (UX-076 criterion 4)',
  () => {
    let target: StartedTarget;
    let report: KitReport;

    beforeAll(async () => {
      target = await startReference();
      report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        otherCredential: target.otherCredential!,
        origin: target.origin,
        testMode: false,
        profiles: ['authz'],
        scenarios: ['authz.anonymous', 'authz.other-tenant', 'authz.service', 'authz.operator'],
      });
    }, 600_000);

    afterAll(async () => {
      await target?.stop();
    });

    for (const id of ['anonymous', 'other-tenant', 'service', 'operator'])
      it(`passes authz.${id}`, () => {
        const s = outcomesOf(report)[`authz.${id}`];
        expect(s?.outcome, JSON.stringify(s)).toBe('passed');
      });
  },
);

describe.skipIf(skip)('without the second credential the cross-tenant scenario is skipped', () => {
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
      scenarios: ['authz.other-tenant'],
    });
  }, 600_000);

  afterAll(async () => {
    await target?.stop();
  });

  it('skips it with the reason', () => {
    const s = outcomesOf(report)['authz.other-tenant'];
    expect(s?.outcome).toBe('skipped');
    expect(s?.reason).toMatch(/second tenant/);
  });
});
