// Bare identifiers in the kit (PRO-045 criterion 4). The table of routes addressed by a bare
// identifier must hold every such route of the protocol definition, each with the feature that
// offers it and a scenario that really calls it; a server that announces a feature whose routes
// have no scenario must fail the run. The thread and comment routes are then called against the
// reference service, started with `comments` announced as an operator announces it. The export and
// asset routes need PostgreSQL and the object store:
// services/document-service/test/postgres/pro-045-bare-identifiers.pg.test.ts.
import { DEP1 } from '@docedit/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bareRoutes,
  isBareIdentifierOperation,
  untestedBareRoutes,
  type BareRoute,
} from '../src/identifiers.ts';
import { PROFILES } from '../src/profiles/index.ts';
import type { KitReport } from '../src/report.ts';
import { runKit } from '../src/runner.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

describe('the table of routes addressed by a bare identifier (PRO-045 criterion 4)', () => {
  it('holds every operation of the definition whose path starts at an identifier of a document resource', () => {
    expect(bareRoutes().map((r) => r.operation)).toEqual([
      'GET /threads/{tid}',
      'PATCH /threads/{tid}',
      'DELETE /threads/{tid}',
      'POST /threads/{tid}/comments',
      'PATCH /comments/{cid}',
      'DELETE /comments/{cid}',
      'POST /assets/{aid}/complete',
      'GET /exports/{jid}',
      'DELETE /exports/{jid}',
      'GET /imports/{jid}',
    ]);
  });

  it('leaves out only the routes of the document itself and those for the service credential alone', () => {
    const left = DEP1.operations
      .filter((o) => o.path.includes('{') && !isBareIdentifierOperation(o))
      .filter((o) => !o.path.startsWith('/documents/{id}'));
    expect(left.map((o) => o.path.split('/')[1])).toEqual([
      'webhooks',
      'webhooks',
      'webhooks',
      'keys',
      'origins',
    ]);
    for (const o of left) expect(o.security).toEqual(['service']);
  });

  it('gives every route an entry, and a feature that the definition names', () => {
    const features = new Set(DEP1.features.map((f) => f.name));
    for (const r of bareRoutes()) {
      expect(r.pending ?? '', r.operation).not.toMatch(/has no entry/);
      if (r.feature !== null) expect(features.has(r.feature), r.operation).toBe(true);
    }
  });

  it('names, for every route a server can announce, a scenario that calls the route and runs when the feature is announced', () => {
    const scenarios = new Map(
      PROFILES.flatMap((p) => p.scenarios.map((s) => [s.id, { profile: p, def: s }] as const)),
    );
    for (const r of bareRoutes().filter((x) => x.feature !== null)) {
      expect(r.scenario, r.operation).not.toBeNull();
      const s = scenarios.get(r.scenario!);
      expect(s, `${r.operation}: ${r.scenario}`).toBeDefined();
      expect(s!.def.covers.operations, r.operation).toContain(r.operation);
      const gate = [
        ...(s!.profile.requires.kind === 'features' ? s!.profile.requires.features : []),
        ...(s!.def.needs?.features ?? []),
      ];
      expect(gate, r.operation).toEqual([r.feature]);
    }
  });

  it('has no scenario only for imports, which no server can announce', () => {
    const none = bareRoutes().filter((r) => r.scenario === null);
    expect(none.map((r) => [r.operation, r.feature])).toEqual([['GET /imports/{jid}', null]]);
  });

  it('reports an announced route without a scenario, and nothing for the routes of today', () => {
    const all = new Set(DEP1.features.map((f) => f.name));
    expect(untestedBareRoutes(all)).toEqual([]);
    const later: BareRoute[] = [
      ...bareRoutes(),
      { operation: 'GET /signatures/{sid}', feature: 'sign', scenario: null },
    ];
    expect(untestedBareRoutes(new Set(['sign', 'exports']), later).map((r) => r.operation)).toEqual(
      ['GET /signatures/{sid}'],
    );
    expect(untestedBareRoutes(new Set(['exports']), later)).toEqual([]);
  });
});

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe.skipIf(skip)(
  'threads and comments of another document on the reference service (PRO-045 criterion 4)',
  () => {
    let target: StartedTarget;
    let report: KitReport;

    beforeAll(async () => {
      target = await startReference({
        env: { DOCEDIT_FEATURES: 'presence,regions,suggest-enforced,read-restrictions,comments' },
      });
      report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
        profiles: ['core', 'comments'],
        scenarios: ['core.identifiers', 'comments.identifiers'],
      });
    }, 300_000);

    afterAll(async () => {
      await target?.stop();
    });

    it('announces comments, and both identifier scenarios run and pass', () => {
      expect(report.bootstrap, target.logs().slice(-2000)).toEqual({ ok: true });
      expect(report.target.features).toContain('comments');
      const ran = report.profiles.flatMap((p) => p.scenarios);
      expect(ran.map((s) => [s.id, s.outcome, s.failure ?? s.reason ?? null])).toEqual([
        ['core.identifiers.table', 'passed', null],
        ['comments.identifiers', 'passed', null],
      ]);
    });

    it('called all six thread and comment routes', () => {
      const s = report.profiles
        .flatMap((p) => p.scenarios)
        .find((x) => x.id === 'comments.identifiers');
      expect(s?.observed?.operations).toEqual(
        expect.arrayContaining([
          'GET /threads/{tid}',
          'PATCH /threads/{tid}',
          'DELETE /threads/{tid}',
          'POST /threads/{tid}/comments',
          'PATCH /comments/{cid}',
          'DELETE /comments/{cid}',
        ]),
      );
    });
  },
);
